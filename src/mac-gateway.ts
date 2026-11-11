/**
 * Standalone local gateway used by the native macOS app.
 *
 * This entry deliberately contains no DSH host imports. It reuses the
 * credential, catalog and upstream layers while exposing the same local
 * OpenAI-compatible surface the DSH adapter already consumes. CCSwitch can
 * translate Claude Messages requests to this upstream format.
 */
import { mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import { defaultDesktopAuthDirs, WorkBuddyCredentialStore } from './auth.ts'
import { WorkBuddyCatalog } from './catalog.ts'
import { createWorkBuddyShim } from './shim.ts'
import { WorkBuddyUpstreamClient, type WorkBuddyRegion } from './upstream.ts'

const regions: readonly WorkBuddyRegion[] = ['cn', 'global']
const appSupport = process.env['WORKBUDDY_GATEWAY_HOME']
  ?? join(process.env['HOME'] ?? '', 'Library', 'Application Support', 'WorkBuddy Model Bridge')
const apiKey = process.env['WORKBUDDY_GATEWAY_API_KEY']?.trim() ?? ''

if (apiKey.length < 32) {
  throw new Error('WORKBUDDY_GATEWAY_API_KEY must contain at least 32 characters')
}

await mkdir(appSupport, { recursive: true, mode: 0o700 })

const client = new WorkBuddyUpstreamClient(message => console.error(`[gateway] ${message}`))
const running: Array<Awaited<ReturnType<typeof createWorkBuddyShim>>> = []
const endpointRows: Array<{
  region: WorkBuddyRegion
  baseUrl: string
  apiKey: string
  signedIn: boolean
  accountCount: number
  modelCount: number
  models: Array<{ id: string; name: string; multiplier?: number }>
}> = []

for (const region of regions) {
  const regionDir = join(appSupport, region)
  const store = new WorkBuddyCredentialStore({
    region,
    authDirs: defaultDesktopAuthDirs(),
    ownPath: join(regionDir, '.workbuddy-auth.json'),
    legacyOwnPath: join(appSupport, '.workbuddy-auth.json'),
    vaultDir: join(appSupport, 'workbuddy-vault', region),
    refresh: credential => client.refreshToken(credential),
  })
  const catalog = new WorkBuddyCatalog(region)
  const accounts = await store.accounts().catch(() => [])
  catalog.setRegionUsable(accounts.length > 0)

  const roster = new Map<string, Awaited<ReturnType<typeof client.fetchModels>>[number]>()
  for (const account of accounts) {
    const credential = await store.credentialFor(account.id).catch(() => undefined)
    if (credential === undefined) continue
    const models = await client.fetchModels(credential).catch(() => [])
    for (const model of models) roster.set(model.id, model)
  }
  if (roster.size > 0) catalog.set([...roster.values()])

  const shim = createWorkBuddyShim({
    store,
    client,
    catalog,
    sharedSecret: apiKey,
    allowMissingOrigin: true,
    port: region === 'cn' ? 15971 : 15972,
    logger: {
      warn: (...values) => console.error('[gateway:warn]', ...values),
      error: (...values) => console.error('[gateway:error]', ...values),
    },
  })
  await shim.ready
  running.push(shim)
  endpointRows.push({
    region,
    baseUrl: shim.baseUrl(),
    apiKey,
    signedIn: accounts.length > 0,
    accountCount: accounts.length,
    modelCount: catalog.current().length,
    models: catalog.current().map(model => ({
      id: model.id,
      name: model.name,
      ...model.creditMultiplier === undefined ? {} : { multiplier: model.creditMultiplier },
    })),
  })
}

// The app consumes this single line from the child process pipe; credentials
// and local endpoint details are never written to a log or a status file.
process.stdout.write(`${JSON.stringify({ kind: 'ready', endpoints: endpointRows })}\n`)

let stopping = false
const stop = async (): Promise<void> => {
  if (stopping) return
  stopping = true
  await Promise.all(running.map(shim => shim.close()))
  process.exit(0)
}
process.once('SIGINT', () => void stop())
process.once('SIGTERM', () => void stop())
