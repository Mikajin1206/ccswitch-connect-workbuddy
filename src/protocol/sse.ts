/**
 * Reader for the OpenAI chat-completions SSE stream the shim itself produces.
 *
 * The protocol adapters reuse the existing `/v1/chat/completions` pipeline by
 * calling it over loopback (需求 §6.1: the adapter owns protocol and model-id
 * conversion; auth refresh, account storage, catalog and upstream logic stay
 * in exactly one place). What comes back is the shim's own SSE framing:
 * `data: {chunk}\n\n` frames, a final `data: [DONE]\n\n`, and errors as JSON.
 *
 * This module turns that byte stream into typed chunks so both adapters
 * translate from ONE shape instead of each parsing SSE again.
 *
 * @module workbuddy-model-bridge/protocol/sse
 */

/** One tool-call delta, as the OpenAI chat stream carries it. */
export interface ChatToolCallDelta {
  /** The call's position in the tool_calls array (per OpenAI streaming). */
  index: number
  /** Present on the FIRST delta of a call. */
  id?: string
  /** Present on the first delta (and repeated by some servers). */
  name?: string
  /** Incremental JSON text for the call's arguments. */
  argumentsDelta: string
}

/** One parsed chat chunk, with everything optional made explicit. */
export interface ChatChunk {
  id?: string
  model?: string
  /** Text appended by this chunk; '' when the chunk carries none. */
  textDelta: string
  toolCalls: ChatToolCallDelta[]
  /** `finish_reason` of the choice, '' while the stream continues. */
  finishReason: string
  usage?: {
    promptTokens?: number
    completionTokens?: number
  }
}

export type ChatStreamEvent =
  | { kind: 'chunk'; chunk: ChatChunk }
  | { kind: 'done' }

function countOf(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

function parseChunk(payload: string): ChatChunk | undefined {
  let parsed: unknown
  try {
    parsed = JSON.parse(payload)
  } catch {
    // A keep-alive or a corrupted frame is skipped rather than fatal: the
    // inner pipeline already repairs its own frames, and one unreadable
    // keep-alive must not end a healthy answer.
    return undefined
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return undefined
  const record = parsed as Record<string, unknown>
  const choices = record['choices']
  const choice = Array.isArray(choices) && typeof choices[0] === 'object' && choices[0] !== null
    ? choices[0] as Record<string, unknown>
    : undefined
  const delta = choice !== undefined && typeof choice['delta'] === 'object' && choice['delta'] !== null
    ? choice['delta'] as Record<string, unknown>
    : undefined
  const rawCalls = delta !== undefined && Array.isArray(delta['tool_calls']) ? delta['tool_calls'] : []
  const toolCalls: ChatToolCallDelta[] = []
  for (const raw of rawCalls) {
    if (typeof raw !== 'object' || raw === null) continue
    const call = raw as Record<string, unknown>
    const fn = typeof call['function'] === 'object' && call['function'] !== null
      ? call['function'] as Record<string, unknown>
      : undefined
    toolCalls.push({
      index: typeof call['index'] === 'number' ? call['index'] : toolCalls.length,
      ...(typeof call['id'] === 'string' && call['id'] !== '' ? { id: call['id'] } : {}),
      ...(typeof fn?.['name'] === 'string' && fn['name'] !== '' ? { name: fn['name'] } : {}),
      argumentsDelta: typeof fn?.['arguments'] === 'string' ? fn['arguments'] : '',
    })
  }
  const usage = typeof record['usage'] === 'object' && record['usage'] !== null
    ? record['usage'] as Record<string, unknown>
    : undefined
  const promptTokens = usage === undefined ? undefined : countOf(usage['prompt_tokens'])
  const completionTokens = usage === undefined ? undefined : countOf(usage['completion_tokens'])
  return {
    ...(typeof record['id'] === 'string' ? { id: record['id'] } : {}),
    ...(typeof record['model'] === 'string' ? { model: record['model'] } : {}),
    textDelta: typeof delta?.['content'] === 'string' ? delta['content'] : '',
    toolCalls,
    finishReason: typeof choice?.['finish_reason'] === 'string' ? choice['finish_reason'] : '',
    ...(promptTokens === undefined && completionTokens === undefined ? {} : {
      usage: {
        ...(promptTokens === undefined ? {} : { promptTokens }),
        ...(completionTokens === undefined ? {} : { completionTokens }),
      },
    }),
  }
}

function dataPayloadOf(frame: string): string | undefined {
  const parts: string[] = []
  for (const line of frame.split('\n')) {
    const trimmed = line.replace(/\r$/, '')
    if (!trimmed.startsWith('data:')) continue
    parts.push(trimmed.slice('data:'.length).trimStart())
  }
  // Multiple `data:` lines of one event join with \n per the SSE spec; the
  // inner pipeline never sends them, but a future shape must not silently
  // drop all but the last.
  return parts.length === 0 ? undefined : parts.join('\n')
}

/**
 * Yield typed events from the inner pipeline's response body.
 *
 * Frames split on a blank line; the trailing `[DONE]` becomes `{kind:'done'}`.
 * An unterminated tail frame is still parsed — the inner pipeline completes
 * terminators itself, and losing the final chunk to a transport quirk would
 * drop the answer's last words.
 */
export async function* readChatStream(
  body: ReadableStream<Uint8Array>,
): AsyncGenerator<ChatStreamEvent> {
  const decoder = new TextDecoder('utf-8')
  let carry = ''
  const reader = body.getReader()
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    carry += decoder.decode(value, { stream: true })
    for (;;) {
      const boundary = carry.indexOf('\n\n')
      if (boundary === -1) break
      const frame = carry.slice(0, boundary)
      carry = carry.slice(boundary + 2)
      const payload = dataPayloadOf(frame)
      if (payload === undefined) continue
      if (payload === '[DONE]') {
        yield { kind: 'done' }
        continue
      }
      const chunk = parseChunk(payload)
      if (chunk !== undefined) yield { kind: 'chunk', chunk }
    }
  }
  const tail = carry + decoder.decode()
  const payload = dataPayloadOf(tail)
  if (payload !== undefined && payload !== '[DONE]') {
    const chunk = parseChunk(payload)
    if (chunk !== undefined) yield { kind: 'chunk', chunk }
  }
  yield { kind: 'done' }
}
