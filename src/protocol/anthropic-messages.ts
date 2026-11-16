/**
 * Anthropic Messages compatible entry (`POST /v1/messages`), for Claude Code
 * and Claude Desktop direct connection (需求 §6.2-2).
 *
 * The adapter owns exactly two things:
 * 1. REQUEST conversion — Anthropic Messages shape → the internal OpenAI chat
 *    body, with the model key resolved to a real WorkBuddy id first;
 * 2. RESPONSE conversion — the inner pipeline's OpenAI chat SSE frames →
 *    Anthropic SSE events (or an aggregated message for `stream: false`).
 *
 * Everything else — credential refresh, account failover, channel gates,
 * tool-call recovery, logging — happens in the inner pipeline, unchanged,
 * because the adapter REUSES it over loopback instead of copying it.
 *
 * Fields the upstream cannot serve are answered with readable errors, never
 * dropped silently (需求 §6.2): `thinking` is rejected with instructions, an
 * unresolvable model key is rejected with the list of servable ids.
 *
 * @module workbuddy-model-bridge/protocol/anthropic-messages
 */

import type { ChatChunk } from './sse.ts'
import type { ModelResolution } from '../model-mapping.ts'

/** What a caller needs to convert one request. */
export type AnthropicModelResolver = (requestedKey: string) => ModelResolution

export type AnthropicRequestConversion =
  | {
    ok: true
    /** The internal chat body, ready for the inner pipeline. */
    chatBodyJson: string
    /** The key the client asked for (echoed in replies). */
    requestedKey: string
    /** The WorkBuddy id that will actually serve. */
    resolvedModelId: string
    /** Whether the client asked to stream. */
    stream: boolean
  }
  | { ok: false; status: number; errorType: string; message: string }

interface AnthropicContentBlock {
  type: string
  text?: string
  id?: string
  name?: string
  input?: unknown
  tool_use_id?: string
  content?: unknown
  is_error?: boolean
  source?: { type?: string; media_type?: string; data?: string; url?: string }
  [key: string]: unknown
}

interface AnthropicRequest {
  model?: unknown
  max_tokens?: unknown
  stream?: unknown
  system?: unknown
  messages?: unknown
  tools?: unknown
  tool_choice?: unknown
  temperature?: unknown
  top_p?: unknown
  stop_sequences?: unknown
  thinking?: unknown
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** Anthropic SSE wire format: an `event:` line plus a `data:` line. */
export function anthropicSseEvent(name: string, data: unknown): string {
  return `event: ${name}\ndata: ${JSON.stringify(data)}\n\n`
}

function invalid(message: string): AnthropicRequestConversion {
  return { ok: false, status: 400, errorType: 'invalid_request_error', message }
}

/** Convert image content to the OpenAI vision part, or name the failure. */
function convertImageBlock(block: AnthropicContentBlock): { ok: true; part: Record<string, unknown> } | { ok: false; message: string } {
  const source = block.source
  if (!isRecord(source)) return { ok: false, message: 'image 内容块缺少 source 字段' }
  if (source.type === 'url' && typeof source.url === 'string') {
    return { ok: true, part: { type: 'image_url', image_url: { url: source.url } } }
  }
  if (source.type === 'base64' && typeof source.media_type === 'string' && typeof source.data === 'string') {
    return {
      ok: true,
      part: { type: 'image_url', image_url: { url: `data:${source.media_type};base64,${source.data}` } },
    }
  }
  return { ok: false, message: `不支持的 image source 类型：${String(source.type ?? '(缺失)')}` }
}

/** Text of a `tool_result`'s content, as one string the tool role accepts. */
function toolResultText(content: unknown): string {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  const parts: string[] = []
  let images = 0
  for (const item of content) {
    if (!isRecord(item)) continue
    if (item['type'] === 'text' && typeof item['text'] === 'string') parts.push(item['text'])
    else if (item['type'] === 'image') images += 1
  }
  if (images > 0) {
    parts.push(`[本次工具结果包含 ${images} 张图片，当前上游链路未转发工具结果中的图片]`)
  }
  return parts.join('\n')
}

/**
 * Convert one Anthropic message into zero or more chat messages.
 *
 * A user turn carrying `tool_result` blocks becomes `role: 'tool'` messages
 * FIRST (the chat contract requires them to directly follow the assistant
 * turn that produced the calls), then one user message with whatever text or
 * image parts remain.
 */
function convertMessage(
  role: unknown,
  content: unknown,
  errors: string[],
): Array<Record<string, unknown>> {
  if (role !== 'user' && role !== 'assistant') {
    errors.push(`消息 role 必须是 user 或 assistant，收到：${String(role)}`)
    return []
  }
  const blocks: AnthropicContentBlock[] = typeof content === 'string'
    ? [{ type: 'text', text: content }]
    : Array.isArray(content)
      ? content.filter(isRecord).map(block => block as AnthropicContentBlock)
      : []
  const chatParts: Array<Record<string, unknown>> = []
  const toolCalls: Array<Record<string, unknown>> = []
  const toolResults: Array<Record<string, unknown>> = []
  for (const block of blocks) {
    if (block.type === 'text' && typeof block.text === 'string') {
      chatParts.push({ type: 'text', text: block.text })
    } else if (block.type === 'image') {
      const image = convertImageBlock(block)
      if (image.ok) chatParts.push(image.part)
      else errors.push(image.message)
    } else if (block.type === 'tool_use' && typeof block.id === 'string' && typeof block.name === 'string') {
      toolCalls.push({
        id: block.id,
        type: 'function',
        function: { name: block.name, arguments: JSON.stringify(block.input ?? {}) },
      })
    } else if (block.type === 'tool_result' && typeof block.tool_use_id === 'string') {
      toolResults.push({ role: 'tool', tool_call_id: block.tool_use_id, content: toolResultText(block.content) })
    } else if (block.type === 'thinking' || block.type === 'redacted_thinking') {
      // Not forwarded: the upstream reasons on its own, and echoing a Claude
      // thinking block upstream would inject text the model never said. The
      // request-time `thinking` rejection below keeps honest clients from
      // relying on round-tripped thinking blocks in the first place.
    } else {
      errors.push(`不支持的内容块类型「${String(block.type)}」已跳过`)
    }
  }
  if (role === 'user') {
    return [...toolResults, ...(chatParts.length > 0 ? [{ role: 'user', content: chatParts }] : [])]
  }
  const text = chatParts.map(part => typeof part['text'] === 'string' ? part['text'] : '').join('')
  return [{
    role: 'assistant',
    ...(text === '' ? { content: null } : { content: text }),
    ...(toolCalls.length > 0 ? { tool_calls: toolCalls } : {}),
  }]
}

/**
 * Convert an Anthropic Messages request into the internal chat body.
 *
 * Every failure names what to change; nothing unsupported rides through to
 * fail later at the upstream with a less readable message.
 */
export function convertAnthropicRequest(
  raw: string,
  resolveModel: AnthropicModelResolver,
): AnthropicRequestConversion {
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch (error) {
    return invalid(`请求体不是合法 JSON：${String(error)}`)
  }
  if (!isRecord(parsed)) return invalid('请求体顶层必须是 JSON 对象')
  const request = parsed as AnthropicRequest
  if (typeof request.model !== 'string' || request.model === '') {
    return invalid('缺少 model 字段（Anthropic Messages 请求必须携带模型键）')
  }
  if (typeof request.max_tokens !== 'number' || !Number.isFinite(request.max_tokens) || request.max_tokens <= 0) {
    return invalid('缺少有效的 max_tokens（必须为正数）；Anthropic Messages 要求该字段')
  }
  if (!Array.isArray(request.messages) || request.messages.length === 0) {
    return invalid('messages 必须是非空数组')
  }
  if (request.thinking !== undefined && isRecord(request.thinking) && request.thinking['type'] === 'enabled') {
    return invalid(
      '当前版本不支持 Anthropic 扩展思考（thinking）：WorkBuddy 上游有自己的推理档位体系，' +
        '透传 thinking 预算会伪造模型能力。请在客户端关闭扩展思考后重试。',
    )
  }
  const resolution = resolveModel(request.model)
  if (!resolution.ok) return invalid(resolution.message)

  const messages: Array<Record<string, unknown>> = []
  const system = request.system
  if (typeof system === 'string' && system !== '') {
    messages.push({ role: 'system', content: system })
  } else if (Array.isArray(system)) {
    const text = system
      .filter(isRecord)
      .map(block => typeof block['text'] === 'string' ? block['text'] : '')
      .filter(text => text !== '')
      .join('\n\n')
    if (text !== '') messages.push({ role: 'system', content: text })
  }
  const conversionErrors: string[] = []
  for (const entry of request.messages) {
    if (!isRecord(entry)) {
      conversionErrors.push('messages 数组元素必须是对象')
      continue
    }
    messages.push(...convertMessage(entry['role'], entry['content'], conversionErrors))
  }
  if (conversionErrors.length > 0) return invalid(`请求包含无法转换的内容：${conversionErrors.join('；')}`)

  const tools = request.tools
  let chatTools: Array<Record<string, unknown>> | undefined
  if (Array.isArray(tools) && tools.length > 0) {
    chatTools = []
    for (const [index, tool] of tools.entries()) {
      if (!isRecord(tool) || typeof tool['name'] !== 'string') {
        return invalid(`tools[${index}] 必须是带 name 的对象`)
      }
      chatTools.push({
        type: 'function',
        function: {
          name: tool['name'],
          ...(typeof tool['description'] === 'string' ? { description: tool['description'] } : {}),
          ...(isRecord(tool['input_schema']) ? { parameters: tool['input_schema'] } : {}),
        },
      })
    }
  }
  const choice = request.tool_choice
  let chatChoice: unknown
  if (isRecord(choice)) {
    if (choice['type'] === 'auto') chatChoice = 'auto'
    else if (choice['type'] === 'any') chatChoice = 'required'
    else if (choice['type'] === 'none') chatChoice = 'none'
    else if (choice['type'] === 'tool' && typeof choice['name'] === 'string') {
      chatChoice = { type: 'function', function: { name: choice['name'] } }
    } else {
      return invalid(`不支持的 tool_choice：${JSON.stringify(choice)}`)
    }
  }

  const chatBody: Record<string, unknown> = {
    model: resolution.modelId,
    max_tokens: request.max_tokens,
    stream: request.stream === true,
    messages,
    ...(chatTools !== undefined ? { tools: chatTools } : {}),
    ...(chatChoice !== undefined ? { tool_choice: chatChoice } : {}),
    ...(typeof request.temperature === 'number' ? { temperature: request.temperature } : {}),
    ...(typeof request.top_p === 'number' ? { top_p: request.top_p } : {}),
    ...(Array.isArray(request.stop_sequences) && request.stop_sequences.length > 0
      ? { stop: request.stop_sequences }
      : {}),
  }
  return {
    ok: true,
    chatBodyJson: JSON.stringify(chatBody),
    requestedKey: request.model,
    resolvedModelId: resolution.modelId,
    stream: request.stream === true,
  }
}

/** Map an OpenAI `finish_reason` to the Anthropic `stop_reason` vocabulary. */
export function anthropicStopReasonOf(finishReason: string): string {
  switch (finishReason) {
    case 'length': return 'max_tokens'
    case 'tool_calls':
    case 'function_call': return 'tool_use'
    case 'content_filter': return 'refusal'
    default: return 'end_turn'
  }
}

interface OpenTextBlock { kind: 'text'; index: number }
interface OpenToolBlock { kind: 'tool'; index: number; id: string; name: string }
type OpenBlock = OpenTextBlock | OpenToolBlock

/**
 * Incremental builder of the Anthropic SSE event sequence from chat chunks.
 *
 * One instance serves one request. `push` turns each chat chunk into zero or
 * more Anthropic events; `finish` closes blocks and emits
 * `message_delta`/`message_stop`. Block indexes are allocated in first-touch
 * order, which is exactly the order the client executes them in.
 */
export class AnthropicStreamTranslator {
  private readonly model: string
  private started = false
  private nextIndex = 0
  private open: OpenBlock | undefined
  private readonly toolBlocks = new Map<number, OpenToolBlock>()
  private stopReason = 'end_turn'
  private inputTokens = 0
  private outputTokens = 0

  constructor(input: { model: string }) {
    this.model = input.model
  }

  private messageStart(): string {
    this.started = true
    return anthropicSseEvent('message_start', {
      type: 'message_start',
      message: {
        id: `msg_bridge_${Date.now().toString(36)}`,
        type: 'message',
        role: 'assistant',
        model: this.model,
        content: [],
        stop_reason: null,
        stop_sequence: null,
        // The inner stream reports token counts only at its end; the true
        // input count cannot be known at start. Documented in the support
        // matrix rather than guessed.
        usage: { input_tokens: this.inputTokens, output_tokens: 0 },
      },
    })
  }

  private openText(): string {
    const index = this.nextIndex
    this.nextIndex += 1
    this.open = { kind: 'text', index }
    return anthropicSseEvent('content_block_start', {
      type: 'content_block_start',
      index,
      content_block: { type: 'text', text: '' },
    })
  }

  private closeOpen(): string {
    const open = this.open
    if (open === undefined) return ''
    this.open = undefined
    return anthropicSseEvent('content_block_stop', { type: 'content_block_stop', index: open.index })
  }

  /** Feed one chat chunk; returns the SSE bytes to write (possibly ''). */
  push(chunk: ChatChunk): string {
    let out = this.started ? '' : this.messageStart()
    if (chunk.usage !== undefined) {
      if (chunk.usage.promptTokens !== undefined) this.inputTokens = chunk.usage.promptTokens
      if (chunk.usage.completionTokens !== undefined) this.outputTokens = chunk.usage.completionTokens
    }
    if (chunk.textDelta !== '') {
      if (this.open?.kind !== 'text') {
        out += this.closeOpen()
        out += this.openText()
      }
      const index = this.open?.index ?? 0
      out += anthropicSseEvent('content_block_delta', {
        type: 'content_block_delta',
        index,
        delta: { type: 'text_delta', text: chunk.textDelta },
      })
    }
    for (const call of chunk.toolCalls) {
      let block = call.index === undefined ? undefined : this.toolBlocks.get(call.index)
      if (block === undefined) {
        out += this.closeOpen()
        const index = this.nextIndex
        this.nextIndex += 1
        block = { kind: 'tool', index, id: call.id ?? `call_${index}`, name: call.name ?? '' }
        this.toolBlocks.set(call.index, block)
        this.open = block
        out += anthropicSseEvent('content_block_start', {
          type: 'content_block_start',
          index,
          content_block: { type: 'tool_use', id: block.id, name: block.name, input: {} },
        })
      }
      if (call.argumentsDelta !== '') {
        out += anthropicSseEvent('content_block_delta', {
          type: 'content_block_delta',
          index: block.index,
          delta: { type: 'input_json_delta', partial_json: call.argumentsDelta },
        })
      }
    }
    if (chunk.finishReason !== '') this.stopReason = anthropicStopReasonOf(chunk.finishReason)
    return out
  }

  /** The closing events: block stops, usage, and `message_stop`. */
  finish(): string {
    if (!this.started) return this.messageStart() + this.finish()
    let out = this.closeOpen()
    out += anthropicSseEvent('message_delta', {
      type: 'message_delta',
      delta: { stop_reason: this.stopReason, stop_sequence: null },
      usage: { output_tokens: this.outputTokens },
    })
    out += anthropicSseEvent('message_stop', { type: 'message_stop' })
    return out
  }

  /** The `api_error` event for a stream that died mid-flight. */
  static midStreamError(message: string): string {
    return anthropicSseEvent('error', { type: 'error', error: { type: 'api_error', message } })
  }
}

export interface AnthropicMessageResult {
  id: string
  type: 'message'
  role: 'assistant'
  model: string
  content: Array<Record<string, unknown>>
  stop_reason: string
  stop_sequence: null
  usage: { input_tokens: number; output_tokens: number }
}

/**
 * Aggregate a whole chat chunk stream into one Anthropic message, for
 * `stream: false` requests. Same mapping rules as the streaming translator;
 * tool arguments are parsed once at the end, and an unparseable argument
 * string is reported as an empty input plus a trailing text note rather than
 * invented.
 */
export function aggregateAnthropicMessage(input: {
  model: string
  chunks: ChatChunk[]
  reasonPhrase?: string
}): AnthropicMessageResult {
  const content: Array<Record<string, unknown>> = []
  let text = ''
  let stopReason = anthropicStopReasonOf(input.reasonPhrase ?? '')
  let inputTokens = 0
  let outputTokens = 0
  const calls = new Map<number, { id: string; name: string; arguments: string }>()
  for (const chunk of input.chunks) {
    if (chunk.usage !== undefined) {
      if (chunk.usage.promptTokens !== undefined) inputTokens = chunk.usage.promptTokens
      if (chunk.usage.completionTokens !== undefined) outputTokens = chunk.usage.completionTokens
    }
    if (chunk.textDelta !== '') text += chunk.textDelta
    for (const call of chunk.toolCalls) {
      const existing = calls.get(call.index) ?? { id: call.id ?? '', name: '', arguments: '' }
      if (existing.id === '' && call.id !== undefined) existing.id = call.id
      if (existing.name === '' && call.name !== undefined) existing.name = call.name
      existing.arguments += call.argumentsDelta
      calls.set(call.index, existing)
    }
    if (chunk.finishReason !== '') stopReason = anthropicStopReasonOf(chunk.finishReason)
  }
  if (text !== '') content.push({ type: 'text', text })
  const orderedCalls = [...calls.entries()].sort((a, b) => a[0] - b[0])
  let argumentParseFailed = false
  for (const [, call] of orderedCalls) {
    let parsed: unknown = {}
    try {
      parsed = call.arguments === '' ? {} : JSON.parse(call.arguments)
    } catch {
      argumentParseFailed = true
    }
    content.push({ type: 'tool_use', id: call.id, name: call.name, input: parsed })
  }
  if (argumentParseFailed) {
    content.push({ type: 'text', text: '[工具调用参数不是合法 JSON，input 置空；原始参数已在上游日志中记录]' })
  }
  return {
    id: `msg_bridge_${Date.now().toString(36)}`,
    type: 'message',
    role: 'assistant',
    model: input.model,
    content,
    stop_reason: stopReason,
    stop_sequence: null,
    usage: { input_tokens: inputTokens, output_tokens: outputTokens },
  }
}

const STATUS_TO_ERROR_TYPE: ReadonlyMap<number, string> = new Map([
  [400, 'invalid_request_error'],
  [401, 'authentication_error'],
  [402, 'invalid_request_error'],
  [403, 'permission_error'],
  [404, 'not_found_error'],
  [408, 'timeout_error'],
  [413, 'request_too_large'],
  [415, 'invalid_request_error'],
  [422, 'invalid_request_error'],
  [429, 'rate_limit_error'],
  [500, 'api_error'],
  [502, 'api_error'],
  [503, 'api_error'],
  [529, 'overloaded_error'],
])

/**
 * Shape an inner-pipeline failure as an Anthropic error body.
 *
 * The inner pipeline's messages are already the readable diagnostics users
 * paste into issues, so only the ENVELOPE changes; `type` maps into the
 * Anthropic vocabulary so clients classify the failure by their own rules.
 */
export function anthropicErrorBody(status: number, innerBodyText: string): { status: number; body: string } {
  const errorType = STATUS_TO_ERROR_TYPE.get(status) ?? 'api_error'
  let message = `WorkBuddy 上游返回了无法解析的失败（http ${status}）`
  try {
    const parsed: unknown = JSON.parse(innerBodyText)
    if (isRecord(parsed) && isRecord(parsed['error'])) {
      const inner = parsed['error'] as Record<string, unknown>
      if (typeof inner['message'] === 'string' && inner['message'] !== '') message = inner['message']
    }
  } catch {
    // Keep the generic sentence; the raw body stays in the inner pipeline's log.
  }
  return { status, body: JSON.stringify({ type: 'error', error: { type: errorType, message } }) + '\n' }
}
