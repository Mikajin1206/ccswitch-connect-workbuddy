/**
 * OpenAI Responses compatible entry (`POST /v1/responses`), for Codex direct
 * connection (需求 §6.2-3).
 *
 * Same architecture as the Anthropic adapter: the request converts to the
 * internal chat body (model key resolved to a real WorkBuddy id, tool calls
 * to the chat vocabulary), the inner pipeline serves it over loopback, and
 * the chat SSE frames convert back to Responses events — streamed or
 * aggregated into a `response` object.
 *
 * Reasoning effort is forwarded ONLY when the catalog confirms the model
 * supports it (需求 §6.3); otherwise it is dropped with a readable header
 * note, never forwarded blind and never invented.
 *
 * @module workbuddy-model-bridge/protocol/openai-responses
 */

import type { ChatChunk } from './sse.ts'
import { decideReasoningEffort } from '../model-mapping.ts'
import type { ModelResolution } from '../model-mapping.ts'

export type ResponsesModelResolver = (requestedKey: string) => ModelResolution

export type ResponsesRequestConversion =
  | {
    ok: true
    chatBodyJson: string
    requestedKey: string
    resolvedModelId: string
    stream: boolean
    /** Set when an explicit reasoning effort was NOT forwarded, and why. */
    reasoningNote?: string
  }
  | { ok: false; status: number; message: string }

interface ResponsesInputItem {
  type?: string
  role?: string
  content?: unknown
  name?: string
  call_id?: string
  id?: string
  arguments?: string
  output?: unknown
  summary?: unknown
  [key: string]: unknown
}

interface ResponsesRequest {
  model?: unknown
  stream?: unknown
  instructions?: unknown
  input?: unknown
  tools?: unknown
  tool_choice?: unknown
  reasoning?: unknown
  max_output_tokens?: unknown
  temperature?: unknown
  top_p?: unknown
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function responsesError(message: string, status = 400): ResponsesRequestConversion {
  return { ok: false, status, message }
}

/** Convert one input content part to a chat content part, or name the failure. */
function convertInputPart(part: unknown, errors: string[]): Record<string, unknown> | undefined {
  if (typeof part === 'string') return { type: 'text', text: part }
  if (!isRecord(part)) {
    errors.push('content 元素必须是字符串或对象')
    return undefined
  }
  const type = part['type']
  if ((type === 'input_text' || type === 'output_text' || type === 'text' || type === 'refusal')
    && typeof part['text'] === 'string') {
    return { type: 'text', text: part['text'] }
  }
  if (type === 'input_image') {
    const imageUrl = part['image_url']
    if (typeof imageUrl === 'string') return { type: 'image_url', image_url: { url: imageUrl } }
    errors.push('input_image 需要 image_url 字符串')
    return undefined
  }
  if (type === 'input_file' || type === 'input_audio') {
    errors.push(`不支持的内容类型「${String(type)}」：当前上游链路不转发文件/音频输入`)
    return undefined
  }
  errors.push(`不支持的内容类型「${String(type ?? '(缺失)')}」`)
  return undefined
}

/** Convert one Responses input item into chat messages, or skip with a note. */
function convertInputItem(item: ResponsesInputItem, errors: string[]): Array<Record<string, unknown>> {
  const type = item.type ?? 'message'
  if (type === 'message') {
    const role = item.role
    if (role !== 'user' && role !== 'assistant' && role !== 'system' && role !== 'developer') {
      errors.push(`input message 的 role 非法：${String(role)}`)
      return []
    }
    // `developer` is OpenAI's newer spelling of the system/developer role; the
    // inner pipeline already rewrites `developer` → `system` for the upstream.
    const parts = typeof item.content === 'string'
      ? [{ type: 'text', text: item.content }]
      : Array.isArray(item.content)
        ? item.content.map(part => convertInputPart(part, errors)).filter(part => part !== undefined)
        : []
    if (parts.length === 0) {
      errors.push('input message 的 content 为空或全部无法转换')
      return []
    }
    return [{ role, content: parts }]
  }
  if (type === 'function_call') {
    if (typeof item.name !== 'string' || typeof item.call_id !== 'string') {
      errors.push('function_call 项需要 name 与 call_id')
      return []
    }
    return [{
      role: 'assistant',
      content: null,
      tool_calls: [{
        id: item.call_id,
        type: 'function',
        function: { name: item.name, arguments: typeof item.arguments === 'string' ? item.arguments : '{}' },
      }],
    }]
  }
  if (type === 'function_call_output') {
    if (typeof item.call_id !== 'string') {
      errors.push('function_call_output 项需要 call_id')
      return []
    }
    const output = typeof item.output === 'string'
      ? item.output
      : JSON.stringify(item.output ?? '')
    return [{ role: 'tool', tool_call_id: item.call_id, content: output }]
  }
  if (type === 'reasoning') {
    // Round-tripped reasoning items carry nothing the chat upstream reads;
    // dropping them here is NOT the forbidden silent drop (that clause is
    // about REQUESTED capabilities), it is conversation bookkeeping.
    return []
  }
  errors.push(`不支持的 input 项类型「${String(type)}」`)
  return []
}

/**
 * Convert a Responses request into the internal chat body.
 *
 * `instructions` become the system message; `input` items convert item by
 * item. The model key is resolved first — a Codex config key that maps to
 * nothing is a readable error, never a blind upstream request.
 */
export function convertResponsesRequest(
  raw: string,
  resolveModel: ResponsesModelResolver,
): ResponsesRequestConversion {
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch (error) {
    return responsesError(`请求体不是合法 JSON：${String(error)}`)
  }
  if (!isRecord(parsed)) return responsesError('请求体顶层必须是 JSON 对象')
  const request = parsed as ResponsesRequest
  if (typeof request.model !== 'string' || request.model === '') {
    return responsesError('缺少 model 字段（Responses 请求必须携带模型键）')
  }
  const resolution = resolveModel(request.model)
  if (!resolution.ok) return responsesError(resolution.message)

  const messages: Array<Record<string, unknown>> = []
  if (typeof request.instructions === 'string' && request.instructions !== '') {
    messages.push({ role: 'system', content: request.instructions })
  }
  const errors: string[] = []
  const input = request.input
  if (typeof input === 'string') {
    if (input !== '') messages.push({ role: 'user', content: [{ type: 'text', text: input }] })
  } else if (Array.isArray(input)) {
    for (const item of input) {
      if (!isRecord(item)) {
        errors.push('input 数组元素必须是对象')
        continue
      }
      messages.push(...convertInputItem(item as ResponsesInputItem, errors))
    }
  } else if (input !== undefined) {
    return responsesError('input 必须是字符串或数组')
  }
  if (errors.length > 0) return responsesError(`请求包含无法转换的内容：${errors.join('；')}`)
  if (messages.length === 0) return responsesError('input 为空：至少需要一条输入消息')

  const tools = request.tools
  let chatTools: Array<Record<string, unknown>> | undefined
  if (Array.isArray(tools) && tools.length > 0) {
    chatTools = []
    for (const [index, tool] of tools.entries()) {
      if (!isRecord(tool) || tool['type'] !== 'function' || typeof tool['name'] !== 'string') {
        return responsesError(`tools[${index}] 必须是 type 为 function 且带 name 的对象`)
      }
      chatTools.push({
        type: 'function',
        function: {
          name: tool['name'],
          ...(typeof tool['description'] === 'string' ? { description: tool['description'] } : {}),
          ...(isRecord(tool['parameters']) ? { parameters: tool['parameters'] } : {}),
        },
      })
    }
  }
  const choice = request.tool_choice
  let chatChoice: unknown
  if (choice === 'auto' || choice === 'none' || choice === 'required') chatChoice = choice
  else if (isRecord(choice) && choice['type'] === 'function' && typeof choice['name'] === 'string') {
    chatChoice = { type: 'function', function: { name: choice['name'] } }
  } else if (choice !== undefined && choice !== null) {
    return responsesError(`不支持的 tool_choice：${JSON.stringify(choice)}`)
  }

  let reasoningNote: string | undefined
  let forwardedEffort: string | undefined
  const reasoning = request.reasoning
  if (isRecord(reasoning) && typeof reasoning['effort'] === 'string' && reasoning['effort'] !== '') {
    const decision = decideReasoningEffort(resolution.model, reasoning['effort'])
    if (decision.action === 'forward') forwardedEffort = decision.effort
    else if (decision.action === 'omit') reasoningNote = decision.note
    else return responsesError(decision.message)
  }

  const chatBody: Record<string, unknown> = {
    model: resolution.modelId,
    stream: request.stream === true,
    messages,
    ...(chatTools !== undefined ? { tools: chatTools } : {}),
    ...(chatChoice !== undefined ? { tool_choice: chatChoice } : {}),
    ...(typeof request.max_output_tokens === 'number' && request.max_output_tokens > 0
      ? { max_tokens: request.max_output_tokens }
      : {}),
    ...(typeof request.temperature === 'number' ? { temperature: request.temperature } : {}),
    ...(typeof request.top_p === 'number' ? { top_p: request.top_p } : {}),
    ...(forwardedEffort !== undefined ? { reasoning_effort: forwardedEffort } : {}),
  }
  return {
    ok: true,
    chatBodyJson: JSON.stringify(chatBody),
    requestedKey: request.model,
    resolvedModelId: resolution.modelId,
    stream: request.stream === true,
    ...(reasoningNote !== undefined ? { reasoningNote } : {}),
  }
}

function sseEvent(name: string, data: unknown): string {
  return `event: ${name}\ndata: ${JSON.stringify(data)}\n\n`
}

function responseSkeleton(input: {
  id: string
  model: string
  status: string
}): Record<string, unknown> {
  return {
    id: input.id,
    object: 'response',
    created_at: Math.floor(Date.now() / 1000),
    status: input.status,
    model: input.model,
    output: [],
    parallel_tool_calls: true,
    tool_choice: 'auto',
    tools: [],
  }
}

interface ResponsesOutputItem {
  type: 'function_call'
  index: number
  callId?: string
  name?: string
  arguments?: string
}

/**
 * Incremental builder of the Responses SSE event sequence from chat chunks.
 *
 * Emits `response.created` on first push, `output_text.delta` per text piece,
 * function-call items with argument deltas, and a final `response.completed`
 * carrying the full output array and usage.
 */
export class ResponsesStreamTranslator {
  private readonly model: string
  private readonly responseId: string
  private started = false
  private nextOutputIndex = 0
  private readonly messageItem: { index: number; text: string }
  private readonly calls = new Map<number, ResponsesOutputItem>()
  private inputTokens = 0
  private outputTokens = 0

  constructor(input: { model: string }) {
    this.model = input.model
    this.responseId = `resp_bridge_${Date.now().toString(36)}`
    this.messageItem = { index: -1, text: '' }
  }

  private responseFor(status: string): Record<string, unknown> {
    const skeleton = responseSkeleton({ id: this.responseId, model: this.model, status })
    skeleton['output'] = this.serializedOutput()
    skeleton['usage'] = {
      input_tokens: this.inputTokens,
      output_tokens: this.outputTokens,
      total_tokens: this.inputTokens + this.outputTokens,
    }
    return skeleton
  }

  private serializedOutput(): Array<Record<string, unknown>> {
    const out: Array<Record<string, unknown>> = []
    const message = this.messageItem
    if (message.index >= 0) {
      out.push({
        type: 'message',
        id: `msg_${this.responseId}`,
        status: 'completed',
        role: 'assistant',
        content: [{ type: 'output_text', text: message.text, annotations: [] }],
      })
    }
    const calls = [...this.calls.values()].sort((a, b) => a.index - b.index)
    for (const call of calls) {
      out.push({
        type: 'function_call',
        id: `fc_${this.responseId}_${call.index}`,
        call_id: call.callId ?? '',
        name: call.name ?? '',
        arguments: call.arguments ?? '',
        status: 'completed',
      })
    }
    return out
  }

  /** Feed one chat chunk; returns SSE bytes to write (possibly ''). */
  push(chunk: ChatChunk): string {
    let out = ''
    if (!this.started) {
      this.started = true
      out += sseEvent('response.created', { type: 'response.created', response: this.responseFor('in_progress') })
    }
    if (chunk.usage !== undefined) {
      if (chunk.usage.promptTokens !== undefined) this.inputTokens = chunk.usage.promptTokens
      if (chunk.usage.completionTokens !== undefined) this.outputTokens = chunk.usage.completionTokens
    }
    if (chunk.textDelta !== '') {
      if (this.messageItem.index === -1) {
        this.messageItem.index = this.nextOutputIndex
        this.nextOutputIndex += 1
        out += sseEvent('response.output_item.added', {
          type: 'response.output_item.added',
          output_index: this.messageItem.index,
          item: { type: 'message', id: `msg_${this.responseId}`, status: 'in_progress', role: 'assistant', content: [] },
        })
        out += sseEvent('response.content_part.added', {
          type: 'response.content_part.added',
          item_id: `msg_${this.responseId}`,
          output_index: this.messageItem.index,
          content_index: 0,
          part: { type: 'output_text', text: '', annotations: [] },
        })
      }
      this.messageItem.text += chunk.textDelta
      out += sseEvent('response.output_text.delta', {
        type: 'response.output_text.delta',
        item_id: `msg_${this.responseId}`,
        output_index: this.messageItem.index,
        content_index: 0,
        delta: chunk.textDelta,
      })
    }
    for (const call of chunk.toolCalls) {
      const existing = this.calls.get(call.index)
      const item = existing ?? {
        type: 'function_call' as const,
        index: this.nextOutputIndex,
        ...(call.id === undefined ? {} : { callId: call.id }),
        ...(call.name === undefined ? {} : { name: call.name }),
        arguments: '',
      }
      if (existing === undefined) {
        this.nextOutputIndex += 1
        this.calls.set(call.index, item)
        out += sseEvent('response.output_item.added', {
          type: 'response.output_item.added',
          output_index: item.index,
          item: { type: 'function_call', id: `fc_${this.responseId}_${item.index}`, call_id: item.callId ?? '', name: item.name ?? '', arguments: '', status: 'in_progress' },
        })
      }
      if (call.argumentsDelta !== '') {
        item.arguments = (item.arguments ?? '') + call.argumentsDelta
        out += sseEvent('response.function_call_arguments.delta', {
          type: 'response.function_call_arguments.delta',
          item_id: `fc_${this.responseId}_${item.index}`,
          output_index: item.index,
          delta: call.argumentsDelta,
        })
      }
    }
    return out
  }

  /** The closing `response.completed` event. */
  finish(): string {
    if (!this.started) {
      return sseEvent('response.created', { type: 'response.created', response: this.responseFor('in_progress') })
        + sseEvent('response.completed', { type: 'response.completed', response: this.responseFor('completed') })
    }
    return sseEvent('response.completed', { type: 'response.completed', response: this.responseFor('completed') })
  }

  /** The body of the aggregated (non-streaming) response object. */
  completedResponse(): Record<string, unknown> {
    return this.responseFor('completed')
  }

  /** The `response.failed` event for a stream that died mid-flight. */
  static midStreamError(input: { model: string; message: string }): string {
    const skeleton = responseSkeleton({ id: `resp_bridge_${Date.now().toString(36)}`, model: input.model, status: 'failed' })
    skeleton['error'] = { code: 'upstream_error', message: input.message }
    return sseEvent('response.failed', { type: 'response.failed', response: skeleton })
  }
}

/** Shape an inner-pipeline failure as an OpenAI error body (passthrough). */
export function responsesErrorBody(status: number, innerBodyText: string): { status: number; body: string } {
  try {
    const parsed: unknown = JSON.parse(innerBodyText)
    if (isRecord(parsed) && isRecord(parsed['error'])) {
      return { status, body: JSON.stringify(parsed) }
    }
  } catch {
    // Fall through to the generic envelope.
  }
  return {
    status,
    body: JSON.stringify({ error: { message: `WorkBuddy 上游返回了无法解析的失败（http ${status}）`, type: 'bridge_error', code: 'upstream_error' } }),
  }
}
