/**
 * Model-key resolution for the direct-connection protocol entries.
 *
 * Clients do not speak WorkBuddy model ids. Claude Code may send an alias the
 * user invented, Claude Desktop speaks in Sonnet/Opus/Haiku ROLES, and Codex
 * sends whatever model key its provider config carries. The protocol adapters
 * call {@link resolveRequestedModel} once per request; everything downstream
 * (failover, per-model refusal records, the usage page) keeps reading the REAL
 * upstream id the resolver produced.
 *
 * Two requirements shape this module (需求 §6.3):
 * - a display name is never mistaken for an upstream id: an unknown key is an
 *   ERROR listing what the region can serve, never a pass-through hope;
 * - a mapping whose target vanished from the catalog stays in the user's
 *   config and fails READABLY, so the UI can offer a rebind instead of a
 *   silent reroute to some other model.
 *
 * @module workbuddy-model-bridge/model-mapping
 */

/** Which client a mapping row belongs to. */
export type BridgeClient = 'claude-code' | 'claude-desktop' | 'codex'

/** The two WorkBuddy regions; each gateway listener serves exactly one. */
export type BridgeRegion = 'cn' | 'global'

/** How a client reaches the bridge; `ccswitch` is the shipping default. */
export type AccessMode = 'ccswitch' | 'direct'

/** One persisted mapping row: what the client sends → what WorkBuddy serves. */
export interface ModelMappingEntry {
  client: BridgeClient
  region: BridgeRegion
  /** The model key the CLIENT sends; '' names the client's default model. */
  modelKey: string
  /** Menu label, shown in UI; never sent upstream. */
  displayName: string
  /** The real WorkBuddy model id this key resolves to. */
  modelId: string
  enabled: boolean
}

/**
 * The slice of a catalog entry the resolver needs.
 *
 * `WorkBuddyUpstreamModel` satisfies this structurally; keeping the type local
 * means the pure functions here stay testable without constructing a full
 * model record.
 */
export interface ResolvableCatalogModel {
  id: string
  reasoning?: {
    supportedEfforts?: readonly string[]
  }
}

/** How the serving id was decided, for headers and the status page. */
export type ResolutionSource = 'mapping' | 'catalog' | 'catalog-single' | 'default'

/** Why a requested model key could not serve, worded for the client. */
export type ModelResolutionFailure =
  | /** A mapping named this key, but its target left the catalog. */
  'mapping-stale'
  /** No mapping, no catalog hit, no usable default. */
  | 'unknown-model'

export type ModelResolution =
  | {
    ok: true
    /** The id that goes upstream. */
    modelId: string
    /** How it was decided, for the response header and the status page. */
    source: ResolutionSource
    /** The catalog entry behind the id, for capability gates. */
    model: ResolvableCatalogModel
  }
  | {
    ok: false
    reason: ModelResolutionFailure
    /** One readable sentence; the adapters put it straight into the reply. */
    message: string
  }

/**
 * The Anthropic ROLE a Claude model key belongs to, or `undefined`.
 *
 * Claude Desktop speaks in roles (`claude-opus-4-1-…` → `opus`), so mappings
 * may be written against the bare role name and keep working across the
 * client's dated-id churn. Deliberately narrow: only the three families the
 * requirement names (需求 §6.3), and only for Claude clients — Codex keys are
 * user-configured strings with no role semantics.
 */
export function claudeRoleOf(modelKey: string): 'opus' | 'sonnet' | 'haiku' | undefined {
  const lowered = modelKey.toLowerCase()
  if (lowered.startsWith('claude-opus')) return 'opus'
  if (lowered.startsWith('claude-sonnet')) return 'sonnet'
  if (lowered.startsWith('claude-haiku')) return 'haiku'
  return undefined
}

/**
 * Clients whose keys carry role semantics, consulted in this order.
 *
 * `/v1/messages` cannot tell WHICH Claude client sent a request (no protocol
 * field names it), so both are tried with `claude-code` first: the two share
 * the resolution rule, and a fixed order keeps an ambiguous key deterministic.
 */
export const ANTHROPIC_ROUTE_CLIENTS: readonly BridgeClient[] = ['claude-code', 'claude-desktop']

/** Find an enabled mapping row for one exact (client, region, key). */
function findMapping(
  mappings: readonly ModelMappingEntry[],
  client: BridgeClient,
  region: BridgeRegion,
  modelKey: string,
): ModelMappingEntry | undefined {
  return mappings.find(entry =>
    entry.enabled && entry.client === client && entry.region === region && entry.modelKey === modelKey
  )
}

/** Readable failure listing what the region CAN serve. */
function unknownModelMessage(
  client: BridgeClient,
  region: BridgeRegion,
  requestedKey: string,
  catalog: readonly ResolvableCatalogModel[],
): string {
  const ids = catalog.map(model => model.id)
  const listing = ids.length === 0
    ? '当前区域没有可用模型（未登录或该区域已关闭）'
    : `可用模型 id：${ids.join('、')}`
  return `无法解析模型键「${requestedKey}」（客户端 ${client}，区域 ${region}）：` +
    `它既不是已配置的映射，也不是 WorkBuddy 目录里的真实模型 id。${listing}。` +
    '请在 Bridge 配置里为该模型键建立映射，或直接使用上面列出的模型 id。'
}

/**
 * Resolve the model key a client sent against mappings and the region catalog.
 *
 * Order, deliberately from most specific to most general:
 * 1. an exact mapping for the requested key (per Claude client, `claude-code`
 *    first when both define one);
 * 2. the key IS a catalog id — the one case a pass-through is safe;
 * 3. the Claude ROLE inside the key (`claude-sonnet-…` → `sonnet`);
 * 4. the client's default mapping (`modelKey: ''`);
 * 5. a single-model catalog (the unambiguous default);
 * 6. a readable failure.
 *
 * A stale mapping (row exists, target gone) fails at step 1 BEFORE any
 * pass-through could rescue it: rerouting to a similar-looking catalog id
 * would silently change which model serves, which the requirement forbids.
 */
export function resolveRequestedModel(input: {
  requestedKey: string
  region: BridgeRegion
  /** The clients to consult, in order; `/v1/responses` passes `['codex']`. */
  clients: readonly BridgeClient[]
  mappings: readonly ModelMappingEntry[]
  catalog: readonly ResolvableCatalogModel[]
}): ModelResolution {
  const { requestedKey, region, clients, mappings, catalog } = input
  const catalogOf = (id: string): ResolvableCatalogModel | undefined =>
    catalog.find(model => model.id === id)
  const mapped = (
    entry: ModelMappingEntry,
    source: ResolutionSource,
  ): ModelResolution | undefined => {
    const model = catalogOf(entry.modelId)
    if (model === undefined) {
      return {
        ok: false,
        reason: 'mapping-stale',
        message: `映射失效：模型键「${requestedKey}」映射到「${entry.modelId}」，` +
          `但它已不在 ${region} 区域的 WorkBuddy 目录里。配置已保留，请在客户端接入设置里重新绑定。`,
      }
    }
    return { ok: true, modelId: model.id, source, model }
  }
  for (const client of clients) {
    const exact = findMapping(mappings, client, region, requestedKey)
    if (exact !== undefined) {
      const resolution = mapped(exact, 'mapping')
      if (resolution !== undefined) return resolution
    }
  }
  const passthrough = catalogOf(requestedKey)
  if (passthrough !== undefined) {
    return { ok: true, modelId: passthrough.id, source: 'catalog', model: passthrough }
  }
  const role = claudeRoleOf(requestedKey)
  if (role !== undefined) {
    for (const client of clients) {
      const byRole = findMapping(mappings, client, region, role)
      if (byRole !== undefined) {
        const resolution = mapped(byRole, 'mapping')
        if (resolution !== undefined) return resolution
      }
    }
  }
  for (const client of clients) {
    const fallback = findMapping(mappings, client, region, '')
    if (fallback !== undefined) {
      const resolution = mapped(fallback, 'default')
      if (resolution !== undefined) return resolution
    }
  }
  if (catalog.length === 1 && catalog[0] !== undefined) {
    return { ok: true, modelId: catalog[0].id, source: 'catalog-single', model: catalog[0] }
  }
  return {
    ok: false,
    reason: 'unknown-model',
    message: unknownModelMessage(clients[0] ?? 'claude-code', region, requestedKey, catalog),
  }
}

/**
 * Whether an explicitly requested reasoning effort may go upstream.
 *
 * The requirement (需求 §6.3) forbids fabricating capability: an effort is
 * forwarded ONLY when the catalog confirms it. Confirmation comes from the
 * model's `reasoning.supportedEfforts`; when the catalog says nothing the
 * effort is DROPPED with a readable marker rather than sent blind — the
 * upstream's own refusal would cost a round trip and blame the wrong layer.
 */
export type ReasoningEffortDecision =
  | { action: 'forward'; effort: string }
  | { action: 'omit'; /** Why it was dropped, for the response header. */ note: string }
  | { action: 'reject'; /** Readable error for the client reply. */ message: string }

export function decideReasoningEffort(
  model: ResolvableCatalogModel | undefined,
  requestedEffort: string,
): ReasoningEffortDecision {
  const supported = model?.reasoning?.supportedEfforts
  if (supported === undefined) {
    return {
      action: 'omit',
      note: `catalog does not confirm reasoning tiers for this model; ` +
        `requested effort「${requestedEffort}」was not forwarded`,
    }
  }
  if (supported.includes(requestedEffort)) return { action: 'forward', effort: requestedEffort }
  return {
    action: 'reject',
    message: `该模型不支持推理档位「${requestedEffort}」（目录确认支持：${supported.join('、') || '无'}）。` +
      '请调整请求的 reasoning.effort，或改用支持该档位的模型。',
  }
}

/** Which mappings point at models the catalog no longer has. */
export function staleMappings(
  mappings: readonly ModelMappingEntry[],
  catalog: readonly ResolvableCatalogModel[],
): Array<{ client: BridgeClient; region: BridgeRegion; modelKey: string; modelId: string }> {
  const ids = new Set(catalog.map(model => model.id))
  return mappings
    .filter(entry => entry.enabled && !ids.has(entry.modelId))
    .map(({ client, region, modelKey, modelId }) => ({ client, region, modelKey, modelId }))
}
