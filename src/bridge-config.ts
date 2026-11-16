/**
 * Versioned local configuration for the bridge: per-client access modes and
 * per-client model mappings (需求 §6.3 / §8).
 *
 * ONE JSON file, `bridge-config.json`, in the app-support directory next to
 * the region credentials. Everything in it is user preference — no key, no
 * token, no WorkBuddy credential ever lands here (those live in the
 * platform credential store), so the file is safe to back up and to hand-edit.
 *
 * Guarantees the requirement asks for:
 * - DEFAULT IS CC SWITCH. An absent file, an absent row, anything unknown
 *   resolves to `ccswitch`; direct connection is always an explicit act.
 * - ATOMIC WRITES. Save goes to `.tmp` and renames, so a crash or a full disk
 *   can never leave half a JSON behind — the reader sees the old file or the
 *   new one, never a fragment.
 * - A CORRUPT FILE NEVER DESTROYS THE LAST VALID CONFIG. Loading fails
 *   READABLY (with the recovery path in the message) and the gateway keeps
 *   running on defaults; the module refuses to overwrite a file it could not
 *   parse, because the half-written bytes are the only evidence a user has of
 *   what went wrong.
 *
 * @module workbuddy-model-bridge/bridge-config
 */

import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import type { AccessMode, BridgeClient, BridgeRegion, ModelMappingEntry } from './model-mapping.ts'

export const BRIDGE_CONFIG_SCHEMA_VERSION = 1

export interface AccessModeEntry {
  client: BridgeClient
  region: BridgeRegion
  mode: AccessMode
}

/** The on-disk document. Absent rows mean "default", never "forbidden". */
export interface BridgeConfigData {
  schemaVersion: typeof BRIDGE_CONFIG_SCHEMA_VERSION
  accessModes: AccessModeEntry[]
  modelMappings: ModelMappingEntry[]
}

/** The config a fresh install runs on: every client on CC Switch, no mappings. */
export function emptyBridgeConfig(): BridgeConfigData {
  return { schemaVersion: BRIDGE_CONFIG_SCHEMA_VERSION, accessModes: [], modelMappings: [] }
}

const CLIENTS: readonly BridgeClient[] = ['claude-code', 'claude-desktop', 'codex']
const REGIONS: readonly BridgeRegion[] = ['cn', 'global']
const MODES: readonly AccessMode[] = ['ccswitch', 'direct']

export class BridgeConfigError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'BridgeConfigError'
  }
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** Parse and fully validate a config document; every failure names its row. */
export function parseBridgeConfig(raw: string): BridgeConfigData {
  let parsed: unknown
  try {
    parsed = JSON.parse(raw.replace(/^\uFEFF/, ''))
  } catch (error) {
    throw new BridgeConfigError(
      `bridge 配置文件不是合法 JSON：${String(error)}。` +
        '请修正或删除该文件（删除后系统按默认值运行：所有客户端走 CC Switch，无模型映射）。',
    )
  }
  if (!isObject(parsed)) {
    throw new BridgeConfigError('bridge 配置文件的顶层必须是 JSON 对象。')
  }
  const version = parsed['schemaVersion']
  if (version !== BRIDGE_CONFIG_SCHEMA_VERSION) {
    throw new BridgeConfigError(
      `bridge 配置文件 schemaVersion 为 ${String(version)}，本程序只认 ${BRIDGE_CONFIG_SCHEMA_VERSION}。` +
        '请升级程序或按文档手工迁移。',
    )
  }
  const accessModes: AccessModeEntry[] = []
  const rawModes = parsed['accessModes']
  if (rawModes !== undefined) {
    if (!Array.isArray(rawModes)) throw new BridgeConfigError('accessModes 必须是数组。')
    for (const [index, entry] of rawModes.entries()) {
      if (!isObject(entry)) throw new BridgeConfigError(`accessModes[${index}] 必须是对象。`)
      const client = entry['client']
      const region = entry['region']
      const mode = entry['mode']
      if (!CLIENTS.includes(client as BridgeClient)) {
        throw new BridgeConfigError(`accessModes[${index}].client 非法：${String(client)}（允许：${CLIENTS.join('、')}）`)
      }
      if (!REGIONS.includes(region as BridgeRegion)) {
        throw new BridgeConfigError(`accessModes[${index}].region 非法：${String(region)}（允许：${REGIONS.join('、')}）`)
      }
      if (!MODES.includes(mode as AccessMode)) {
        throw new BridgeConfigError(`accessModes[${index}].mode 非法：${String(mode)}（允许：${MODES.join('、')}）`)
      }
      accessModes.push({ client: client as BridgeClient, region: region as BridgeRegion, mode: mode as AccessMode })
    }
  }
  const modelMappings: ModelMappingEntry[] = []
  const rawMappings = parsed['modelMappings']
  if (rawMappings !== undefined) {
    if (!Array.isArray(rawMappings)) throw new BridgeConfigError('modelMappings 必须是数组。')
    for (const [index, entry] of rawMappings.entries()) {
      if (!isObject(entry)) throw new BridgeConfigError(`modelMappings[${index}] 必须是对象。`)
      const client = entry['client']
      const region = entry['region']
      const modelKey = entry['modelKey']
      const modelId = entry['modelId']
      if (!CLIENTS.includes(client as BridgeClient)) {
        throw new BridgeConfigError(`modelMappings[${index}].client 非法：${String(client)}`)
      }
      if (!REGIONS.includes(region as BridgeRegion)) {
        throw new BridgeConfigError(`modelMappings[${index}].region 非法：${String(region)}`)
      }
      if (typeof modelKey !== 'string') {
        throw new BridgeConfigError(`modelMappings[${index}].modelKey 必须是字符串（客户端请求里的模型键；空字符串表示该客户端的默认模型）。`)
      }
      if (typeof entry['displayName'] !== 'string') {
        throw new BridgeConfigError(`modelMappings[${index}].displayName 必须是字符串。`)
      }
      if (typeof modelId !== 'string' || modelId.trim() === '') {
        throw new BridgeConfigError(`modelMappings[${index}].modelId 必须是非空字符串（WorkBuddy 真实模型 id）。`)
      }
      modelMappings.push({
        client: client as BridgeClient,
        region: region as BridgeRegion,
        modelKey,
        displayName: entry['displayName'] as string,
        modelId: modelId.trim(),
        enabled: entry['enabled'] !== false,
      })
    }
  }
  return { schemaVersion: BRIDGE_CONFIG_SCHEMA_VERSION, accessModes, modelMappings }
}

/**
 * Read + write the config file, remembering the last valid parse.
 *
 * {@link load} throws {@link BridgeConfigError} on a corrupt file — the caller
 * decides how to surface it. {@link saveOrRefuse} refuses to write when the
 * last attempt to READ the same file failed: writing would replace the
 * evidence with a clean file and silently drop the user's rows.
 */
export class BridgeConfigFile {
  /** The error from the most recent failed load, for the status page. */
  loadError: string | undefined

  constructor(readonly path: string) {}

  /** Parse the file; a missing file is the normal fresh-install case. */
  load(): BridgeConfigData {
    let raw: string
    try {
      raw = readFileSync(this.path, 'utf8')
    } catch (error: unknown) {
      const code = (error as NodeJS.ErrnoException | undefined)?.code
      if (code === 'ENOENT') {
        this.loadError = undefined
        return emptyBridgeConfig()
      }
      this.loadError = `读取 bridge 配置失败：${String(error)}`
      throw new BridgeConfigError(this.loadError)
    }
    try {
      const data = parseBridgeConfig(raw)
      this.loadError = undefined
      return data
    } catch (error: unknown) {
      this.loadError = error instanceof BridgeConfigError ? error.message : String(error)
      throw error
    }
  }

  /**
   * Atomically persist `data`, or return the reason nothing was written.
   *
   * The write is `.tmp` + rename (same directory, same filesystem — rename is
   * atomic there), so a reader in another process sees the old or the new
   * document, never a torn one. Refuses after a failed load of the SAME path:
   * a config we could not parse must not be silently replaced.
   */
  saveOrRefuse(data: BridgeConfigData): { ok: true } | { ok: false; reason: string } {
    if (this.loadError !== undefined) {
      return {
        ok: false,
        reason: '上次读取配置文件失败，为保留现场拒绝写入；请先修正文件内容。' + this.loadError,
      }
    }
    const payload = JSON.stringify(data, null, 2) + '\n'
    const tmp = `${this.path}.tmp`
    try {
      mkdirSync(dirname(this.path), { recursive: true })
      writeFileSync(tmp, payload, 'utf8')
      renameSync(tmp, this.path)
      return { ok: true }
    } catch (error: unknown) {
      return { ok: false, reason: `写入 bridge 配置失败（原配置未受影响）：${String(error)}` }
    }
  }
}

/**
 * Per-request view the gateway hands to the shim.
 *
 * A corrupt file must not take chat down: {@link snapshot} falls back to
 * defaults and remembers the failure for `/bridge/status`, where the recovery
 * sentence is shown verbatim. The file is re-read on every snapshot because
 * the gateway is a CHILD process — the app UI writes the file in its own
 * process, and re-reading is what makes edits land without a restart.
 */
export class BridgeSettings {
  private failure: string | undefined

  constructor(private readonly file: BridgeConfigFile) {}

  snapshot(): BridgeConfigData {
    try {
      const data = this.file.load()
      this.failure = undefined
      return data
    } catch (error: unknown) {
      this.failure = error instanceof BridgeConfigError ? error.message : String(error)
      return emptyBridgeConfig()
    }
  }

  getAccessMode(client: BridgeClient, region: BridgeRegion): AccessMode {
    const row = this.snapshot().accessModes.find(entry => entry.client === client && entry.region === region)
    return row?.mode ?? 'ccswitch'
  }

  /** The readable failure from the most recent snapshot, for the status page. */
  statusError(): string | undefined {
    return this.failure
  }
}
