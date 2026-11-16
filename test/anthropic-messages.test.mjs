import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { readChatStream } from '../src/protocol/sse.ts'
import {
  anthropicErrorBody,
  anthropicStopReasonOf,
  AnthropicStreamTranslator,
  aggregateAnthropicMessage,
  convertAnthropicRequest,
} from '../src/protocol/anthropic-messages.ts'

const here = dirname(fileURLToPath(import.meta.url))
const fixture = name => readFileSync(join(here, 'fixtures', name), 'utf8')

const resolveOk = key => ({
  ok: true,
  modelId: 'wb-chat-cn',
  source: 'mapping',
  model: { id: 'wb-chat-cn', reasoning: { supportedEfforts: ['medium', 'high'] } },
})

test('请求转换：fixture 全量字段转换为 chat 语义', () => {
  const request = fixture(join('anthropic-messages', 'request-tools.json'))
  const expected = JSON.parse(fixture(join('anthropic-messages', 'expected-chat-tools.json')))
  const result = convertAnthropicRequest(request, resolveOk)
  assert.equal(result.ok, true)
  if (!result.ok) return
  const chat = JSON.parse(result.chatBodyJson)
  assert.deepEqual(chat, expected)
  assert.equal(result.requestedKey, 'claude-sonnet-4-5-20250929')
  assert.equal(result.resolvedModelId, 'wb-chat-cn')
})

test('请求转换：system 为字符串时成为首条 system 消息', () => {
  const result = convertAnthropicRequest(
    JSON.stringify({ model: 'a', max_tokens: 100, system: '你是助手。', messages: [{ role: 'user', content: 'hi' }] }),
    resolveOk,
  )
  assert.equal(result.ok, true)
  if (!result.ok) return
  const chat = JSON.parse(result.chatBodyJson)
  assert.deepEqual(chat.messages[0], { role: 'system', content: '你是助手。' })
})

test('请求转换：失败都带可读 message 与 400', () => {
  const cases = [
    ['非法 JSON', '{'],
    ['缺 model', JSON.stringify({ max_tokens: 1, messages: [{ role: 'user', content: 'x' }] })],
    ['缺 max_tokens', JSON.stringify({ model: 'a', messages: [{ role: 'user', content: 'x' }] })],
    ['messages 为空', JSON.stringify({ model: 'a', max_tokens: 1, messages: [] })],
    ['thinking 请求', JSON.stringify({ model: 'a', max_tokens: 1, messages: [{ role: 'user', content: 'x' }], thinking: { type: 'enabled', budget_tokens: 100 } })],
    ['模型解析失败', JSON.stringify({ model: 'ghost', max_tokens: 1, messages: [{ role: 'user', content: 'x' }] })],
  ]
  for (const [label, raw] of cases) {
    const result = convertAnthropicRequest(raw, () => ({ ok: false, reason: 'unknown-model', message: '无法解析模型键「ghost」' }))
    assert.equal(result.ok, false, label)
    if (!result.ok) {
      assert.equal(result.status, 400, label)
      assert.equal(result.errorType, 'invalid_request_error', label)
      assert.ok(result.message.length > 0, label)
    }
  }
})

async function chunksFromSse(text) {
  const stream = new ReadableStream({
    start(controller) {
      controller.enqueue(new TextEncoder().encode(text))
      controller.close()
    },
  })
  const chunks = []
  for await (const event of readChatStream(stream)) {
    if (event.kind === 'chunk') chunks.push(event.chunk)
  }
  return chunks
}

test('流式翻译：文本 + 工具调用流产生合法的 Anthropic 事件序列', async () => {
  const chunks = await chunksFromSse(fixture(join('openai-chat-sse', 'text-and-tool-stream.txt')))
  const translator = new AnthropicStreamTranslator({ model: 'claude-sonnet-4-5-20250929' })
  let sse = ''
  for (const chunk of chunks) sse += translator.push(chunk)
  sse += translator.finish()

  const events = sse.split('\n\n').filter(block => block !== '').map(block => {
    const lines = block.split('\n')
    const name = lines.find(line => line.startsWith('event:'))?.slice('event:'.length).trim()
    const data = JSON.parse(lines.find(line => line.startsWith('data:'))?.slice('data:'.length).trim() ?? '{}')
    return { name, data }
  })
  const names = events.map(event => event.name)
  assert.deepEqual(names, [
    'message_start',
    'content_block_start',
    'content_block_delta',
    'content_block_delta',
    'content_block_stop',
    'content_block_start',
    'content_block_delta',
    'content_block_delta',
    'content_block_stop',
    'message_delta',
    'message_stop',
  ])
  const start = events[0]?.data
  assert.equal(start?.type, 'message_start')
  assert.equal(start?.message?.model, 'claude-sonnet-4-5-20250929')
  assert.equal(start?.message?.usage?.input_tokens, 0)
  const toolStart = events[5]?.data
  assert.equal(toolStart?.content_block?.type, 'tool_use')
  assert.equal(toolStart?.content_block?.id, 'call_1')
  assert.equal(toolStart?.content_block?.name, 'get_weather')
  const argumentDeltas = events
    .filter(event => event.name === 'content_block_delta' && event.data.delta?.type === 'input_json_delta')
    .map(event => event.data.delta.partial_json)
    .join('')
  assert.equal(argumentDeltas, '{"city":"测试市"}')
  const toolIndex = toolStart?.index
  const argumentEvent = events.find(event => event.name === 'content_block_delta' && event.data.delta?.type === 'input_json_delta')
  assert.equal(argumentEvent?.data.index, toolIndex)
  const messageDelta = events[9]?.data
  assert.equal(messageDelta?.type, 'message_delta')
  assert.equal(messageDelta?.delta?.stop_reason, 'tool_use')
  assert.equal(messageDelta?.usage?.output_tokens, 7)
})

test('聚合：非流式请求得到完整 message 对象', async () => {
  const chunks = await chunksFromSse(fixture(join('openai-chat-sse', 'text-and-tool-stream.txt')))
  const message = aggregateAnthropicMessage({ model: 'claude-sonnet-4-5-20250929', chunks })
  assert.equal(message.type, 'message')
  assert.equal(message.role, 'assistant')
  assert.equal(message.stop_reason, 'tool_use')
  assert.deepEqual(message.usage, { input_tokens: 11, output_tokens: 7 })
  assert.deepEqual(message.content[0], { type: 'text', text: '今天天气晴。' })
  const toolUse = message.content[1]
  assert.equal(toolUse?.type, 'tool_use')
  assert.deepEqual(toolUse?.input, { city: '测试市' })
})

test('stop_reason 映射表', () => {
  assert.equal(anthropicStopReasonOf('stop'), 'end_turn')
  assert.equal(anthropicStopReasonOf('length'), 'max_tokens')
  assert.equal(anthropicStopReasonOf('tool_calls'), 'tool_use')
  assert.equal(anthropicStopReasonOf('content_filter'), 'refusal')
  assert.equal(anthropicStopReasonOf(''), 'end_turn')
})

test('上游错误体映射为 Anthropic 错误信封', () => {
  const shaped = anthropicErrorBody(429, JSON.stringify({ error: { message: '模型当前负载较高', type: 'model_busy', code: 'model_busy' } }))
  assert.equal(shaped.status, 429)
  const parsed = JSON.parse(shaped.body)
  assert.equal(parsed.type, 'error')
  assert.equal(parsed.error.type, 'rate_limit_error')
  assert.equal(parsed.error.message, '模型当前负载较高')
  const upstream = anthropicErrorBody(502, 'not json at all')
  assert.equal(JSON.parse(upstream.body).error.type, 'api_error')
})
