import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, readFileSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  BridgeConfigError,
  BridgeConfigFile,
  BridgeSettings,
  emptyBridgeConfig,
  parseBridgeConfig,
} from '../src/bridge-config.ts'

function tempConfigPath(content) {
  const dir = mkdtempSync(join(tmpdir(), 'wb-bridge-config-'))
  const path = join(dir, 'bridge-config.json')
  if (content !== undefined) writeFileSync(path, content, 'utf8')
  return path
}

test('默认值：文件不存在时所有客户端处于 CC Switch 模式', () => {
  const path = tempConfigPath()
  try {
    const settings = new BridgeSettings(new BridgeConfigFile(path))
    assert.deepEqual(settings.snapshot(), emptyBridgeConfig())
    for (const client of ['claude-code', 'claude-desktop', 'codex']) {
      assert.equal(settings.getAccessMode(client, 'cn'), 'ccswitch')
      assert.equal(settings.getAccessMode(client, 'global'), 'ccswitch')
    }
  } finally {
    rmSync(join(path, '..'), { recursive: true, force: true })
  }
})

test('解析：合法文档的行按字段读回', () => {
  const data = parseBridgeConfig(JSON.stringify({
    schemaVersion: 1,
    accessModes: [{ client: 'claude-code', region: 'cn', mode: 'direct' }],
    modelMappings: [{
      client: 'codex',
      region: 'global',
      modelKey: 'gpt-5-codex',
      displayName: '工作台编码',
      modelId: 'wb-code-global',
      enabled: true,
    }],
  }))
  assert.equal(data.accessModes.length, 1)
  assert.equal(data.accessModes[0]?.mode, 'direct')
  assert.equal(data.modelMappings[0]?.modelId, 'wb-code-global')
})

test('解析：enabled 缺省为 true', () => {
  const data = parseBridgeConfig(JSON.stringify({
    schemaVersion: 1,
    modelMappings: [{
      client: 'claude-code', region: 'cn', modelKey: 'a', displayName: '甲', modelId: 'wb-a',
    }],
  }))
  assert.equal(data.modelMappings[0]?.enabled, true)
})

test('解析：每类非法输入都报可读错误并指明行号字段', () => {
  const bad = [
    ['不是 JSON', '{ nope'],
    ['顶层不是对象', '[]'],
    ['版本不符', JSON.stringify({ schemaVersion: 99 })],
    ['client 非法', JSON.stringify({ schemaVersion: 1, accessModes: [{ client: 'siri', region: 'cn', mode: 'direct' }] })],
    ['mode 非法', JSON.stringify({ schemaVersion: 1, accessModes: [{ client: 'codex', region: 'cn', mode: 'yolo' }] })],
    ['modelId 为空', JSON.stringify({ schemaVersion: 1, modelMappings: [{ client: 'codex', region: 'cn', modelKey: 'a', displayName: '甲', modelId: ' ' }] })],
  ]
  for (const [label, raw] of bad) {
    assert.throws(() => parseBridgeConfig(raw), BridgeConfigError, label)
  }
})

test('解析：带 BOM 的文件照常读取（Windows 编辑器常见）', () => {
  const body = JSON.stringify({ schemaVersion: 1, accessModes: [] })
  const data = parseBridgeConfig('\uFEFF' + body)
  assert.equal(data.schemaVersion, 1)
})

test('原子保存：写入后可读回；临时文件不留痕', () => {
  const path = tempConfigPath()
  try {
    const file = new BridgeConfigFile(path)
    const result = file.saveOrRefuse({
      schemaVersion: 1,
      accessModes: [{ client: 'claude-code', region: 'global', mode: 'direct' }],
      modelMappings: [],
    })
    assert.deepEqual(result, { ok: true })
    assert.equal(readFileSync(path, 'utf8').includes('"mode": "direct"'), true)
    const listed = readdirSync(join(path, '..'))
    assert.equal(listed.some(name => name.endsWith('.tmp')), false)
  } finally {
    rmSync(join(path, '..'), { recursive: true, force: true })
  }
})

test('损坏文件：读取报可读错误，写入被拒绝以保留现场', () => {
  const path = tempConfigPath('{ "schemaVersion": 1, ')
  try {
    const file = new BridgeConfigFile(path)
    assert.throws(() => file.load(), BridgeConfigError)
    const result = file.saveOrRefuse(emptyBridgeConfig())
    assert.equal(result.ok, false)
    if (!result.ok) assert.ok(result.reason.includes('拒绝写入'))
    // 现场保留：坏文件没有被好文件覆盖
    assert.equal(readFileSync(path, 'utf8'), '{ "schemaVersion": 1, ')
  } finally {
    rmSync(join(path, '..'), { recursive: true, force: true })
  }
})

test('运行期视图：损坏文件不拖垮请求，快照退回默认值并记录错误', () => {
  const path = tempConfigPath('corrupt')
  try {
    const settings = new BridgeSettings(new BridgeConfigFile(path))
    assert.deepEqual(settings.snapshot(), emptyBridgeConfig())
    assert.equal(settings.getAccessMode('codex', 'cn'), 'ccswitch')
    const failure = settings.statusError()
    assert.ok(typeof failure === 'string' && failure.length > 0)
  } finally {
    rmSync(join(path, '..'), { recursive: true, force: true })
  }
})

test('运行期视图：配置修复后无需重启即可生效', () => {
  const path = tempConfigPath()
  try {
    const settings = new BridgeSettings(new BridgeConfigFile(path))
    assert.equal(settings.getAccessMode('claude-code', 'cn'), 'ccswitch')
    writeFileSync(path, JSON.stringify({
      schemaVersion: 1,
      accessModes: [{ client: 'claude-code', region: 'cn', mode: 'direct' }],
      modelMappings: [],
    }), 'utf8')
    assert.equal(settings.getAccessMode('claude-code', 'cn'), 'direct')
    assert.equal(settings.statusError(), undefined)
  } finally {
    rmSync(join(path, '..'), { recursive: true, force: true })
  }
})
