/**
 * End-to-end: the direct-connection routes served by a REAL shim.
 *
 * A fake upstream client plays WorkBuddy (it records what it was asked so the
 * test can prove the model key was RESOLVED, not passed through), the shim
 * runs on a random loopback port, and the tests drive it with plain fetch —
 * exactly what Claude Code / Codex would do.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { request as httpRequest } from 'node:http'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createWorkBuddyShim } from '../src/shim.ts'
import { BridgeSettings, BridgeConfigFile } from '../src/bridge-config.ts'

const SECRET = 'e2e-shared-secret-0123456789-abcdefgh'
const CHAT_SSE = [
  'data: {"id":"chatcmpl-e2e","choices":[{"index":0,"delta":{"role":"assistant"},"finish_reason":""}]}',
  '',
  'data: {"id":"chatcmpl-e2e","choices":[{"index":0,"delta":{"content":"网关直连正常。"},"finish_reason":""}]}',
  '',
  'data: {"id":"chatcmpl-e2e","choices":[{"index":0,"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":9,"completion_tokens":3}}',
  '',
  'data: [DONE]',
  '',
].join('\n')

function makeHarness() {
  const dir = mkdtempSync(join(tmpdir(), 'wb-bridge-e2e-'))
  const configPath = join(dir, 'bridge-config.json')
  writeFileSync(configPath, JSON.stringify({
    schemaVersion: 1,
    accessModes: [],
    modelMappings: [
      {
        client: 'claude-code',
        region: 'cn',
        modelKey: 'claude-sonnet-4-5-20250929',
        displayName: '工作台对话',
        modelId: 'wb-chat-cn',
        enabled: true,
      },
      {
        client: 'codex',
        region: 'cn',
        modelKey: 'gpt-5-codex',
        displayName: '工作台编码',
        modelId: 'wb-code-cn',
        enabled: true,
      },
    ],
  }), 'utf8')
  const upstreamBodies = []
  const client = {
    async chatStream(_credential, bodyJson, _signal) {
      upstreamBodies.push(JSON.parse(bodyJson))
      return { ok: true, response: new Response(CHAT_SSE, { headers: { 'content-type': 'text/event-stream' } }) }
    },
  }
  const store = { resolve: async () => ({}) }
  const settings = new BridgeSettings(new BridgeConfigFile(configPath))
  const shim = createWorkBuddyShim({
    store,
    client,
    catalog: { current: () => [{ id: 'wb-chat-cn', reasoning: { supportedEfforts: ['high'] } }, { id: 'wb-code-cn' }] },
    sharedSecret: SECRET,
    allowMissingOrigin: true,
    region: 'cn',
    bridge: { settings },
  })
  const cleanup = async () => {
    await shim.close()
    rmSync(dir, { recursive: true, force: true })
  }
  return { shim, settings, configPath, upstreamBodies, cleanup }
}

const authHeaders = extra => ({
  authorization: `Bearer ${SECRET}`,
  'content-type': 'application/json',
  ...extra,
})

test('POST /v1/messages 流式：Anthropic 事件序列 + 模型解析头 + 上游收到真实 id', async () => {
  const harness = makeHarness()
  try {
    await harness.shim.ready
    const base = harness.shim.baseUrl()
    const response = await fetch(`${base}/v1/messages`, {
      method: 'POST',
      headers: authHeaders(),
      body: JSON.stringify({
        model: 'claude-sonnet-4-5-20250929',
        max_tokens: 256,
        stream: true,
        system: '你是助手。',
        messages: [{ role: 'user', content: [{ type: 'text', text: 'ping' }] }],
      }),
    })
    assert.equal(response.status, 200)
    assert.equal(response.headers.get('content-type')?.includes('text/event-stream'), true)
    assert.equal(response.headers.get('x-workbuddy-resolved-model'), 'wb-chat-cn')
    const sse = await response.text()
    const names = sse.split('\n\n').filter(Boolean).map(block =>
      block.split('\n').find(line => line.startsWith('event:'))?.slice(6).trim())
    assert.equal(names[0], 'message_start')
    assert.ok(names.includes('content_block_delta'))
    assert.equal(names.at(-1), 'message_stop')
    // THE key assertion of direct mode: the client's display alias never
    // reaches the upstream; the resolved WorkBuddy id does.
    assert.equal(harness.upstreamBodies[0]?.model, 'wb-chat-cn')
    assert.equal(harness.upstreamBodies[0]?.messages?.[0]?.role, 'system')
  } finally {
    await harness.cleanup()
  }
})

test('POST /v1/messages 非流式：聚合成完整 message', async () => {
  const harness = makeHarness()
  try {
    await harness.shim.ready
    const base = harness.shim.baseUrl()
    const response = await fetch(`${base}/v1/messages`, {
      method: 'POST',
      headers: authHeaders(),
      body: JSON.stringify({
        model: 'claude-sonnet-4-5-20250929',
        max_tokens: 256,
        stream: false,
        messages: [{ role: 'user', content: 'ping' }],
      }),
    })
    assert.equal(response.status, 200)
    const message = await response.json()
    assert.equal(message.type, 'message')
    assert.equal(message.role, 'assistant')
    assert.equal(message.content[0]?.text, '网关直连正常。')
    assert.equal(message.stop_reason, 'end_turn')
    assert.deepEqual(message.usage, { input_tokens: 9, output_tokens: 3 })
  } finally {
    await harness.cleanup()
  }
})

test('POST /v1/messages：未知模型键得到 Anthropic 形状的可读错误', async () => {
  const harness = makeHarness()
  try {
    await harness.shim.ready
    const base = harness.shim.baseUrl()
    const response = await fetch(`${base}/v1/messages`, {
      method: 'POST',
      headers: authHeaders(),
      body: JSON.stringify({ model: 'no-such-model', max_tokens: 1, messages: [{ role: 'user', content: 'x' }] }),
    })
    assert.equal(response.status, 400)
    const body = await response.json()
    assert.equal(body.type, 'error')
    assert.equal(body.error.type, 'invalid_request_error')
    assert.ok(body.error.message.includes('wb-chat-cn'))
    assert.equal(harness.upstreamBodies.length, 0)
  } finally {
    await harness.cleanup()
  }
})

test('POST /v1/messages：thinking 请求被明确拒绝而不是静默丢弃', async () => {
  const harness = makeHarness()
  try {
    await harness.shim.ready
    const base = harness.shim.baseUrl()
    const response = await fetch(`${base}/v1/messages`, {
      method: 'POST',
      headers: authHeaders(),
      body: JSON.stringify({
        model: 'claude-sonnet-4-5-20250929',
        max_tokens: 1,
        messages: [{ role: 'user', content: 'x' }],
        thinking: { type: 'enabled', budget_tokens: 100 },
      }),
    })
    assert.equal(response.status, 400)
    const body = await response.json()
    assert.ok(body.error.message.includes('thinking'))
    assert.equal(harness.upstreamBodies.length, 0)
  } finally {
    await harness.cleanup()
  }
})

test('POST /v1/responses：Codex 模型键映射 + 聚合 response 对象', async () => {
  const harness = makeHarness()
  try {
    await harness.shim.ready
    const base = harness.shim.baseUrl()
    const response = await fetch(`${base}/v1/responses`, {
      method: 'POST',
      headers: authHeaders(),
      body: JSON.stringify({ model: 'gpt-5-codex', input: '列出目录', stream: false }),
    })
    assert.equal(response.status, 200)
    assert.equal(response.headers.get('x-workbuddy-resolved-model'), 'wb-code-cn')
    const payload = await response.json()
    assert.equal(payload.object, 'response')
    assert.equal(payload.status, 'completed')
    assert.equal(payload.output[0]?.content?.[0]?.text, '网关直连正常。')
    assert.equal(harness.upstreamBodies[0]?.model, 'wb-code-cn')
  } finally {
    await harness.cleanup()
  }
})

test('GET /bridge/status：协议、模式、映射清点；配置改动即时生效', async () => {
  const harness = makeHarness()
  try {
    await harness.shim.ready
    const base = harness.shim.baseUrl()
    const first = await (await fetch(`${base}/bridge/status`, { headers: authHeaders() })).json()
    assert.equal(first.ok, true)
    assert.equal(first.region, 'cn')
    assert.equal(first.protocols['anthropic-messages'], true)
    assert.equal(first.protocols['openai-responses'], true)
    assert.equal(first.accessModes['claude-code'], 'ccswitch')
    assert.equal(first.mappings.enabled, 2)
    assert.equal(first.configError, undefined)
    // The app UI writes the file in its own process; the gateway must see the
    // change on the next status call without a restart.
    harness.settings.snapshot()
    writeFileSync(harness.configPath, JSON.stringify({
      schemaVersion: 1,
      accessModes: [{ client: 'claude-code', region: 'cn', mode: 'direct' }],
      modelMappings: [],
    }), 'utf8')
    const second = await (await fetch(`${base}/bridge/status`, { headers: authHeaders() })).json()
    assert.equal(second.accessModes['claude-code'], 'direct')
    assert.equal(second.mappings.enabled, 0)
  } finally {
    await harness.cleanup()
  }
})

// `fetch` derives the Host header from the URL and ignores overrides, so the
// forged-host check goes over node:http, which sends whatever Host we set.
function rawRequest(url, headers, body) {
  return new Promise((resolve, reject) => {
    const url_ = new URL(url)
    const req = httpRequest({
      hostname: url_.hostname,
      port: url_.port,
      path: url_.pathname,
      method: 'POST',
      headers,
    }, res => {
      let text = ''
      res.on('data', chunk => { text += chunk })
      res.on('end', () => resolve({ status: res.statusCode, body: text }))
    })
    req.on('error', reject)
    req.end(body)
  })
}

test('新入口与既有面共享同一套回环防护：缺 bearer 401、跨源 Host 403', async () => {
  const harness = makeHarness()
  try {
    await harness.shim.ready
    const base = harness.shim.baseUrl()
    const noAuth = await fetch(`${base}/v1/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'x', max_tokens: 1, messages: [{ role: 'user', content: 'x' }] }),
    })
    assert.equal(noAuth.status, 401)
    const body = JSON.stringify({ model: 'x', max_tokens: 1, messages: [{ role: 'user', content: 'x' }] })
    const evilHost = await rawRequest(`${base}/v1/messages`, {
      host: 'evil.example.com',
      authorization: `Bearer ${SECRET}`,
      'content-type': 'application/json',
    }, body)
    assert.equal(evilHost.status, 403)
    const wrongAuth = await fetch(`${base}/v1/responses`, {
      method: 'POST',
      headers: authHeaders({ authorization: `Bearer ${'0'.repeat(40)}` }),
      body: JSON.stringify({ model: 'x', input: 'x' }),
    })
    assert.equal(wrongAuth.status, 401)
  } finally {
    await harness.cleanup()
  }
})

test('不配置 bridge 时旧行为不变：/v1/messages 仍是 404', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'wb-bridge-legacy-'))
  try {
    const shim = createWorkBuddyShim({
      store: { resolve: async () => ({}) },
      client: { async chatStream() { return { ok: true, response: new Response('data: [DONE]\n\n') } } },
      catalog: { current: () => [] },
      sharedSecret: SECRET,
      allowMissingOrigin: true,
    })
    await shim.ready
    const response = await fetch(`${shim.baseUrl()}/v1/messages`, {
      method: 'POST',
      headers: { authorization: `Bearer ${shim.token()}`, 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'x', max_tokens: 1, messages: [{ role: 'user', content: 'x' }] }),
    })
    assert.equal(response.status, 404)
    await shim.close()
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
