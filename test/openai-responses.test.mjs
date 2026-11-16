import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { readChatStream } from '../src/protocol/sse.ts'
import {
  convertResponsesRequest,
  ResponsesStreamTranslator,
  responsesErrorBody,
} from '../src/protocol/openai-responses.ts'

const here = dirname(fileURLToPath(import.meta.url))
const fixture = name => readFileSync(join(here, 'fixtures', name), 'utf8')

const resolveOk = key => ({
  ok: true,
  modelId: 'wb-code-cn',
  source: 'mapping',
  model: { id: 'wb-code-cn', reasoning: { supportedEfforts: ['high'] } },
})

test('请求转换：fixture（函数调用 + 工具结果 + 推理档位）转换为 chat 语义', () => {
  const request = fixture(join('openai-responses', 'request-function-call.json'))
  const expected = JSON.parse(fixture(join('openai-responses', 'expected-chat-function-call.json')))
  const result = convertResponsesRequest(request, resolveOk)
  assert.equal(result.ok, true)
  if (!result.ok) return
  const chat = JSON.parse(result.chatBodyJson)
  assert.deepEqual(chat, expected)
})

test('请求转换：input 为纯字符串时成为单条用户消息', () => {
  const result = convertResponsesRequest(
    JSON.stringify({ model: 'a', input: '你好' }),
    resolveOk,
  )
  assert.equal(result.ok, true)
  if (!result.ok) return
  const chat = JSON.parse(result.chatBodyJson)
  assert.deepEqual(chat.messages, [{ role: 'user', content: [{ type: 'text', text: '你好' }] }])
})

test('请求转换：reasoning effort 目录未确认时省略并带可读说明', () => {
  const result = convertResponsesRequest(
    JSON.stringify({ model: 'a', input: 'x', reasoning: { effort: 'medium' } }),
    () => ({ ok: true, modelId: 'wb-x', source: 'catalog', model: { id: 'wb-x' } }),
  )
  assert.equal(result.ok, true)
  if (!result.ok) return
  const chat = JSON.parse(result.chatBodyJson)
  assert.equal(chat.reasoning_effort, undefined)
  assert.ok(result.reasoningNote?.includes('medium'))
})

test('请求转换：reasoning effort 目录不支持时明确拒绝', () => {
  const result = convertResponsesRequest(
    JSON.stringify({ model: 'a', input: 'x', reasoning: { effort: 'low' } }),
    resolveOk,
  )
  assert.equal(result.ok, false)
  if (!result.ok) assert.ok(result.message.includes('high'))
})

test('请求转换：失败场景都带可读 message', () => {
  const cases = [
    ['非法 JSON', '{'],
    ['缺 model', JSON.stringify({ input: 'x' })],
    ['input 为空数组', JSON.stringify({ model: 'a', input: [] })],
    ['模型解析失败', JSON.stringify({ model: 'ghost', input: 'x' })],
  ]
  for (const [label, raw] of cases) {
    const result = convertResponsesRequest(raw, () => ({ ok: false, reason: 'unknown-model', message: '无法解析模型键' }))
    assert.equal(result.ok, false, label)
    if (!result.ok) assert.equal(result.status, 400, label)
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

test('流式翻译：文本流产生 Responses 事件序列并以 response.completed 收尾', async () => {
  const sseText = [
    'data: {"id":"chatcmpl-t","choices":[{"index":0,"delta":{"role":"assistant"},"finish_reason":""}]}',
    '',
    'data: {"id":"chatcmpl-t","choices":[{"index":0,"delta":{"content":"你好"},"finish_reason":""}]}',
    '',
    'data: {"id":"chatcmpl-t","choices":[{"index":0,"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":5,"completion_tokens":2}}',
    '',
    'data: [DONE]',
    '',
    '',
  ].join('\n')
  const chunks = await chunksFromSse(sseText)
  const translator = new ResponsesStreamTranslator({ model: 'gpt-5-codex' })
  let sse = ''
  for (const chunk of chunks) sse += translator.push(chunk)
  sse += translator.finish()

  const events = sse.split('\n\n').filter(block => block !== '').map(block => {
    const lines = block.split('\n')
    const name = lines.find(line => line.startsWith('event:'))?.slice('event:'.length).trim()
    const data = JSON.parse(lines.find(line => line.startsWith('data:'))?.slice('data:'.length).trim() ?? '{}')
    return { name, data }
  })
  assert.deepEqual(events.map(event => event.name), [
    'response.created',
    'response.output_item.added',
    'response.content_part.added',
    'response.output_text.delta',
    'response.completed',
  ])
  const completed = events.at(-1)?.data?.response
  assert.equal(completed?.object, 'response')
  assert.equal(completed?.status, 'completed')
  assert.deepEqual(completed?.usage, { input_tokens: 5, output_tokens: 2, total_tokens: 7 })
  assert.deepEqual(completed?.output?.[0]?.content?.[0], { type: 'output_text', text: '你好', annotations: [] })
})

test('聚合：非流式得到完整 response 对象，工具调用进 output', async () => {
  const chunks = await chunksFromSse(fixture(join('openai-chat-sse', 'text-and-tool-stream.txt')))
  const translator = new ResponsesStreamTranslator({ model: 'gpt-5-codex' })
  for (const chunk of chunks) translator.push(chunk)
  const response = translator.completedResponse()
  assert.equal(response.status, 'completed')
  const call = response.output.find(item => item.type === 'function_call')
  assert.equal(call?.name, 'get_weather')
  assert.equal(call?.arguments, '{"city":"测试市"}')
  assert.equal(call?.call_id, 'call_1')
})

test('上游错误体：已是 OpenAI 形状则原样透传', () => {
  const inner = JSON.stringify({ error: { message: '模型当前负载较高', type: 'model_busy', code: 'model_busy' } })
  const shaped = responsesErrorBody(429, inner)
  assert.equal(shaped.status, 429)
  assert.deepEqual(JSON.parse(shaped.body), JSON.parse(inner))
  const fallback = responsesErrorBody(502, 'not json')
  assert.equal(JSON.parse(fallback.body).error.type, 'bridge_error')
})
