import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  claudeRoleOf,
  resolveRequestedModel,
  decideReasoningEffort,
  staleMappings,
} from '../src/model-mapping.ts'

const catalog = [
  { id: 'wb-chat-cn', reasoning: { supportedEfforts: ['low', 'medium', 'high'] } },
  { id: 'wb-code-cn', reasoning: { supportedEfforts: ['high'] } },
  { id: 'wb-vision-cn' },
]

const mappings = [
  {
    client: 'claude-code',
    region: 'cn',
    modelKey: 'claude-sonnet-4-5-20250929',
    displayName: '工作台对话',
    modelId: 'wb-chat-cn',
    enabled: true,
  },
  {
    client: 'claude-desktop',
    region: 'cn',
    modelKey: 'sonnet',
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
  {
    client: 'claude-code',
    region: 'cn',
    modelKey: '',
    displayName: '默认对话',
    modelId: 'wb-chat-cn',
    enabled: true,
  },
  {
    client: 'claude-code',
    region: 'cn',
    modelKey: 'stale-alias',
    displayName: '失效映射',
    modelId: 'wb-gone',
    enabled: true,
  },
  {
    client: 'claude-code',
    region: 'cn',
    modelKey: 'disabled-alias',
    displayName: '已停用',
    modelId: 'wb-chat-cn',
    enabled: false,
  },
]

test('精确映射命中：claude-code 的自定义别名解析到真实模型 id', () => {
  const result = resolveRequestedModel({
    requestedKey: 'claude-sonnet-4-5-20250929',
    region: 'cn',
    clients: ['claude-code', 'claude-desktop'],
    mappings,
    catalog,
  })
  assert.equal(result.ok, true)
  if (result.ok) {
    assert.equal(result.modelId, 'wb-chat-cn')
    assert.equal(result.source, 'mapping')
  }
})

test('目录直通：请求键就是真实模型 id 时直接通过', () => {
  const result = resolveRequestedModel({
    requestedKey: 'wb-vision-cn',
    region: 'cn',
    clients: ['claude-code', 'claude-desktop'],
    mappings,
    catalog,
  })
  assert.equal(result.ok, true)
  if (result.ok) {
    assert.equal(result.modelId, 'wb-vision-cn')
    assert.equal(result.source, 'catalog')
  }
})

test('角色映射：Claude Desktop 按 sonnet/opus/haiku 角色命中', () => {
  const result = resolveRequestedModel({
    requestedKey: 'claude-sonnet-4-5-20250929',
    region: 'cn',
    clients: ['claude-desktop'],
    mappings,
    catalog,
  })
  assert.equal(result.ok, true)
  if (result.ok) {
    assert.equal(result.modelId, 'wb-chat-cn')
    assert.equal(result.source, 'mapping')
  }
})

test('角色归一只对 claude 前缀生效', () => {
  assert.equal(claudeRoleOf('claude-opus-4-1'), 'opus')
  assert.equal(claudeRoleOf('claude-haiku-4-5'), 'haiku')
  assert.equal(claudeRoleOf('gpt-5-codex'), undefined)
  assert.equal(claudeRoleOf('wb-chat-cn'), undefined)
})

test('codex 的映射只按精确键解析', () => {
  const result = resolveRequestedModel({
    requestedKey: 'gpt-5-codex',
    region: 'cn',
    clients: ['codex'],
    mappings,
    catalog,
  })
  assert.equal(result.ok, true)
  if (result.ok) assert.equal(result.modelId, 'wb-code-cn')
})

test('默认映射（modelKey 为空）兜底未知别名', () => {
  const result = resolveRequestedModel({
    requestedKey: 'my-custom-alias',
    region: 'cn',
    clients: ['claude-code'],
    mappings,
    catalog,
  })
  assert.equal(result.ok, true)
  if (result.ok) {
    assert.equal(result.modelId, 'wb-chat-cn')
    assert.equal(result.source, 'default')
  }
})

test('目录只剩一个模型时唯一模型兜底', () => {
  const result = resolveRequestedModel({
    requestedKey: 'anything',
    region: 'cn',
    clients: ['codex'],
    mappings: [],
    catalog: [{ id: 'wb-only' }],
  })
  assert.equal(result.ok, true)
  if (result.ok) {
    assert.equal(result.modelId, 'wb-only')
    assert.equal(result.source, 'catalog-single')
  }
})

test('映射失效：目标模型离开目录时报可读错误，不做静默改道', () => {
  const result = resolveRequestedModel({
    requestedKey: 'stale-alias',
    region: 'cn',
    clients: ['claude-code'],
    mappings,
    catalog,
  })
  assert.equal(result.ok, false)
  if (!result.ok) {
    assert.equal(result.reason, 'mapping-stale')
    assert.ok(result.message.includes('wb-gone'))
    assert.ok(result.message.includes('重新绑定'))
  }
})

test('完全未知且无兜底：报错并列出可用模型', () => {
  const result = resolveRequestedModel({
    requestedKey: 'nope',
    region: 'cn',
    clients: ['codex'],
    mappings: [],
    catalog,
  })
  assert.equal(result.ok, false)
  if (!result.ok) {
    assert.equal(result.reason, 'unknown-model')
    assert.ok(result.message.includes('wb-chat-cn'))
    assert.ok(result.message.includes('wb-code-cn'))
  }
})

test('停用的映射不参与解析（落到默认映射）', () => {
  const result = resolveRequestedModel({
    requestedKey: 'disabled-alias',
    region: 'cn',
    clients: ['claude-code'],
    mappings,
    catalog,
  })
  assert.equal(result.ok, true)
  if (result.ok) assert.equal(result.source, 'default')
})

test('区域隔离：路由层按区域过滤映射后，cn 的映射不为 global 服务', () => {
  const globalMappings = mappings.filter(entry => entry.region === 'global')
  const result = resolveRequestedModel({
    requestedKey: 'claude-sonnet-4-5-20250929',
    region: 'global',
    clients: ['claude-code', 'claude-desktop'],
    mappings: globalMappings,
    catalog,
  })
  assert.equal(result.ok, false)
  if (!result.ok) assert.equal(result.reason, 'unknown-model')
})

test('推理档位：目录确认支持时转发', () => {
  const decision = decideReasoningEffort(catalog[0], 'medium')
  assert.equal(decision.action, 'forward')
  if (decision.action === 'forward') assert.equal(decision.effort, 'medium')
})

test('推理档位：目录确认不支持时拒绝并列出支持档位', () => {
  const decision = decideReasoningEffort(catalog[1], 'low')
  assert.equal(decision.action, 'reject')
  if (decision.action === 'reject') assert.ok(decision.message.includes('high'))
})

test('推理档位：目录未声明时降级省略并给出可读说明', () => {
  const decision = decideReasoningEffort(catalog[2], 'medium')
  assert.equal(decision.action, 'omit')
  if (decision.action === 'omit') assert.ok(decision.note.includes('wb') === false)
})

test('失效映射清点：状态页用它标记需要重新绑定的行', () => {
  const stale = staleMappings(mappings, catalog)
  assert.equal(stale.length, 1)
  assert.equal(stale[0]?.modelId, 'wb-gone')
})
