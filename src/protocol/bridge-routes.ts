/**
 * Route handlers for the direct-connection protocol entries, shared by
 * `/v1/messages` (Anthropic Messages) and `/v1/responses` (OpenAI Responses).
 *
 * The data path is deliberately BORING (需求 §6.1): each handler converts the
 * protocol request into the internal chat body, calls the shim's OWN
 * `/v1/chat/completions` over loopback with the process secret, and converts
 * the answer back. No upstream logic is duplicated: failover, channel gates,
 * tool-call recovery and logging keep running exactly once, in the pipeline
 * that already owns them. The extra hop is loopback-only and adds no new
 * listener; the loopback guards (Host/Origin/bearer) apply to it like to any
 * other client.
 *
 * @module workbuddy-model-bridge/protocol/bridge-routes
 */

import type { IncomingMessage, ServerResponse } from 'node:http'
import type { BridgeConfigData } from '../bridge-config.ts'
import type { BridgeSettings } from '../bridge-config.ts'
import type { BridgeClient, BridgeRegion, ModelMappingEntry, ModelResolution } from '../model-mapping.ts'
import { ANTHROPIC_ROUTE_CLIENTS, resolveRequestedModel, staleMappings } from '../model-mapping.ts'
import type { ResolvableCatalogModel } from '../model-mapping.ts'
import { readChatStream } from './sse.ts'
import type { ChatChunk } from './sse.ts'
import {
  anthropicErrorBody,
  AnthropicStreamTranslator,
  aggregateAnthropicMessage,
  convertAnthropicRequest,
} from './anthropic-messages.ts'
import {
  convertResponsesRequest,
  ResponsesStreamTranslator,
  responsesErrorBody,
} from './openai-responses.ts'

/** Local logger shape; structurally compatible with the shim's. */
export interface BridgeLogger {
  warn(...values: unknown[]): void
  error(...values: unknown[]): void
}

/** What the gateway needs from persisted preferences, per request. */
export type BridgeSettingsView = Pick<BridgeSettings, 'snapshot' | 'getAccessMode' | 'statusError'>

export interface BridgeRouteContext {
  /** The region this shim serves; mappings and the catalog are per region. */
  region: BridgeRegion
  catalog: { current(): readonly ResolvableCatalogModel[] }
  settings: BridgeSettingsView
  logger?: BridgeLogger
  /** The shim's capped body reader (keeps the 413 handling in one place). */
  readRequestBody(req: IncomingMessage): Promise<Buffer>
  /** True when the error is the body-cap rejection (answered with 413). */
  isBodyTooLarge(error: unknown): boolean
  /** The shim's own chat endpoint, valid after ready. */
  chatEndpoint(): string
  /** The process secret the inner call must carry. */
  secret: string
}

interface ProtocolConversionOk {
  ok: true
  chatBodyJson: string
  requestedKey: string
  resolvedModelId: string
  stream: boolean
  reasoningNote?: string
}

interface ProtocolConversionError {
  ok: false
  status: number
  message: string
  /** Anthropic only; the Responses shape carries the type inside its error. */
  errorType?: string
}

type ProtocolConversion = ProtocolConversionOk | ProtocolConversionError

interface ProtocolErrorBody {
  status: number
  body: string
}

interface ProtocolTranslator {
  push(chunk: ChatChunk): string
  finish(): string
}

function writeBody(
  res: ServerResponse,
  status: number,
  body: string,
  contentType: string,
  headers?: Readonly<Record<string, string>>,
): void {
  res.writeHead(status, {
    'Content-Type': contentType,
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-cache',
    ...headers,
  })
  res.end(body)
}

/**
 * Build the three handlers. One instance per shim; the context is fixed for
 * the shim's lifetime, while mappings and access modes are re-read from the
 * settings file on EVERY request so UI edits land without a restart.
 */
export function createBridgeRouteHandlers(ctx: BridgeRouteContext): {
  anthropicMessages(req: IncomingMessage, res: ServerResponse): Promise<void>
  openaiResponses(req: IncomingMessage, res: ServerResponse): Promise<void>
  status(): Record<string, unknown>
} {
  const configFor = (): { data: BridgeConfigData; mappings: ModelMappingEntry[]; catalog: readonly ResolvableCatalogModel[] } => {
    const data = ctx.settings.snapshot()
    return {
      data,
      mappings: data.modelMappings.filter(entry => entry.region === ctx.region),
      catalog: ctx.catalog.current(),
    }
  }

  const jsonError = (res: ServerResponse, status: number, message: string, headers?: Readonly<Record<string, string>>): void => {
    writeBody(res, status, JSON.stringify({ error: { message, type: 'bridge_error', code: 'invalid_request' } }), 'application/json', headers)
  }

  /**
   * The shared two-way conversion flow.
   *
   * Everything protocol-specific arrives as small callbacks, so the loopback
   * call, the abort wiring, the streaming pump and the error paths exist
   * exactly once.
   */
  const serve = async (input: {
    req: IncomingMessage
    res: ServerResponse
    clients: readonly BridgeClient[]
    convert(raw: string, resolve: (key: string) => ModelResolution): ProtocolConversion
    /** A conversion failure, already shaped in the protocol's envelope. */
    writeConversionError(res: ServerResponse, failure: ProtocolConversionError): void
    errorBody(status: number, innerBodyText: string): ProtocolErrorBody
    makeTranslator(model: string): ProtocolTranslator
    midStreamError(model: string, message: string): string
    aggregate(model: string, chunks: ChatChunk[]): unknown
    contentType: string
  }): Promise<void> => {
    const type = input.req.headers['content-type']
    if (typeof type !== 'string' || !type.trim().toLowerCase().startsWith('application/json')) {
      jsonError(input.res, 415, 'Content-Type 必须是 application/json')
      return
    }
    let raw: string
    try {
      raw = (await ctx.readRequestBody(input.req)).toString('utf8')
    } catch (error: unknown) {
      if (ctx.isBodyTooLarge(error)) {
        jsonError(input.res, 413, '请求体超过大小上限')
        return
      }
      throw error
    }
    const { mappings, catalog } = configFor()
    const conversion = input.convert(raw, requestedKey => resolveRequestedModel({
      requestedKey,
      region: ctx.region,
      clients: input.clients,
      mappings,
      catalog,
    }))
    if (!conversion.ok) {
      input.writeConversionError(input.res, conversion)
      return
    }
    const responseHeaders: Record<string, string> = {
      'x-workbuddy-resolved-model': conversion.resolvedModelId,
    }
    if (conversion.reasoningNote !== undefined) {
      responseHeaders['x-workbuddy-reasoning-note'] = conversion.reasoningNote
    }

    const controller = new AbortController()
    // Same rule as the inner pipeline: watch the RESPONSE's close, not the
    // request's — `req` 'close' fires when its body finishes reading, which
    // would abort every healthy request.
    input.res.on('close', () => controller.abort())
    let inner: Response
    try {
      inner = await fetch(ctx.chatEndpoint(), {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'authorization': `Bearer ${ctx.secret}`,
        },
        body: conversion.chatBodyJson,
        signal: controller.signal,
      })
    } catch (error: unknown) {
      if (controller.signal.aborted) return
      ctx.logger?.error('workbuddy bridge: inner chat call failed', error)
      jsonError(input.res, 502, '内部 chat 通道调用失败（网关自身不可用）')
      return
    }
    if (!inner.ok) {
      const innerText = await inner.text().catch(() => '')
      // Nothing has streamed yet, so the failure is a plain JSON answer —
      // what every Anthropic/OpenAI client expects for a pre-stream error.
      const shaped = input.errorBody(inner.status, innerText)
      writeBody(input.res, shaped.status, shaped.body, 'application/json', responseHeaders)
      return
    }
    if (inner.body === null) {
      jsonError(input.res, 502, '内部 chat 通道返回了空响应体', responseHeaders)
      return
    }

    const translator = input.makeTranslator(conversion.requestedKey)
    if (!conversion.stream) {
      const chunks: ChatChunk[] = []
      try {
        for await (const event of readChatStream(inner.body)) {
          if (event.kind === 'chunk') chunks.push(event.chunk)
        }
      } catch (error: unknown) {
        if (controller.signal.aborted) return
        jsonError(input.res, 502, `内部 chat 通道流读取失败：${String(error)}`, responseHeaders)
        return
      }
      writeBody(
        input.res,
        200,
        JSON.stringify(input.aggregate(conversion.requestedKey, chunks)),
        'application/json',
        responseHeaders,
      )
      return
    }

    input.res.writeHead(200, {
      'Content-Type': input.contentType,
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
      'X-Accel-Buffering': 'no',
      ...responseHeaders,
    })
    try {
      for await (const event of readChatStream(inner.body)) {
        if (input.res.writable === false) break
        if (event.kind === 'chunk') input.res.write(translator.push(event.chunk))
      }
      if (input.res.writable) input.res.write(translator.finish())
    } catch (error: unknown) {
      if (!controller.signal.aborted && input.res.writable) {
        input.res.write(input.midStreamError(conversion.requestedKey, `内部 chat 通道流中断：${String(error)}`))
      }
    }
    input.res.end()
  }

  const anthropicConversionError = (res: ServerResponse, failure: ProtocolConversionError): void => {
    writeBody(
      res,
      failure.status,
      JSON.stringify({ type: 'error', error: { type: failure.errorType ?? 'invalid_request_error', message: failure.message } }) + '\n',
      'application/json',
    )
  }

  const responsesConversionError = (res: ServerResponse, failure: ProtocolConversionError): void => {
    writeBody(
      res,
      failure.status,
      JSON.stringify({ error: { message: failure.message, type: 'invalid_request_error', code: 'invalid_request' } }),
      'application/json',
    )
  }

  /** Aggregate chat chunks into a Responses `response` object. */
  const aggregateResponses = (model: string, chunks: ChatChunk[]): Record<string, unknown> => {
    const translator = new ResponsesStreamTranslator({ model })
    for (const chunk of chunks) translator.push(chunk)
    return translator.completedResponse()
  }

  const anthropicMessages = (req: IncomingMessage, res: ServerResponse): Promise<void> => serve({
    req,
    res,
    clients: ANTHROPIC_ROUTE_CLIENTS,
    convert: convertAnthropicRequest,
    writeConversionError: anthropicConversionError,
    errorBody: anthropicErrorBody,
    makeTranslator: model => new AnthropicStreamTranslator({ model }),
    midStreamError: (_model, message) => AnthropicStreamTranslator.midStreamError(message),
    aggregate: (model, chunks) => aggregateAnthropicMessage({ model, chunks }),
    contentType: 'text/event-stream',
  })

  const openaiResponses = (req: IncomingMessage, res: ServerResponse): Promise<void> => serve({
    req,
    res,
    clients: ['codex'],
    convert: convertResponsesRequest,
    writeConversionError: responsesConversionError,
    errorBody: responsesErrorBody,
    makeTranslator: model => new ResponsesStreamTranslator({ model }),
    midStreamError: (model, message) => ResponsesStreamTranslator.midStreamError({ model, message }),
    aggregate: aggregateResponses,
    contentType: 'text/event-stream',
  })

  const status = (): Record<string, unknown> => {
    const { data, mappings, catalog } = configFor()
    const accessModes: Record<string, string> = {}
    for (const client of ['claude-code', 'claude-desktop', 'codex'] as const) {
      accessModes[client] = ctx.settings.getAccessMode(client, ctx.region)
    }
    const failure = ctx.settings.statusError()
    return {
      ok: true,
      region: ctx.region,
      protocols: { 'openai-chat': true, 'anthropic-messages': true, 'openai-responses': true },
      accessModes,
      models: catalog.length,
      mappings: {
        total: mappings.length,
        enabled: mappings.filter(entry => entry.enabled).length,
        stale: staleMappings(mappings, catalog),
      },
      ...(failure !== undefined ? { configError: failure } : {}),
    }
  }

  return { anthropicMessages, openaiResponses, status }
}
