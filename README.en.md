# WorkBuddy Model Bridge for macOS and Windows

A standalone native SwiftUI macOS app that connects locally signed-in WorkBuddy subscription models to Claude Code, Claude Desktop and Codex — through CC Switch, or proxied directly by the app.中文文档：[README.md](README.md)。

## Attribution and porting logic

The original DSH plugin was created by **LaoDing (老丁, GitHub [`dingminhua`](https://github.com/dingminhua))** and is licensed under the project [MIT License](LICENSE). Thank you to the original author for open-sourcing the WorkBuddy integration. This project is an independent macOS adaptation in its own repository. The DSH plugin repository remains separate.

The adapter reuses the repository's credential discovery and refresh, regional model catalogs, upstream client, and secured loopback shim. A separate `src/mac-gateway.ts` entry starts one local endpoint per region without importing DSH host modules or invoking WorkBuddy CLI. The SwiftUI app launches the bundled Node runtime and gateway, stores its random local API key in macOS Keychain, and keeps WorkBuddy credentials under the user's Application Support directory. CC Switch performs the Claude Messages to OpenAI Chat Completions conversion. The gateway supplies model inference from the WorkBuddy subscription; **Claude's harness remains responsible for task execution, tool use, and local file operations**.

The app icon is an edited derivative of the WorkBuddy app icon. WorkBuddy and related marks remain the property of their respective owners; this project is unaffiliated with or endorsed by WorkBuddy or Tencent.

## Build

Requirements: macOS 14 or newer, Xcode 27.2 or newer, Node.js 22 or newer, and pnpm.

```sh
pnpm install
bash macos/build-app.sh
```

The resulting app is `macos/build/WorkBuddy Model Bridge.app`. The app bundle includes the Node runtime found on the build machine and the compiled gateway. Open the Swift package at `macos/WorkBuddyModelBridge` in Xcode for native SwiftUI development.

The build also creates `macos/build/WorkBuddy Model Bridge.zip`, preserving the `.app` bundle for installation. Unzip it and drag the app to **Applications**. The app starts the local gateway when its main window opens. Closing the window leaves the app and gateway running; use the menu bar **sparkles** menu to reopen the window, stop or start the gateway, or quit the app. Quitting the app stops the gateway.

## Connect CC Switch

1. Open **WorkBuddy Model Bridge**. It reads the local WorkBuddy desktop sign-in and publishes separate domestic and international endpoints.
2. In CC Switch, add a Claude provider for each region you use.
3. Set the provider's upstream API format to **OpenAI Chat Completions**.
4. Use the corresponding Base URL and API Key shown on the app's Overview page.
5. Enable CC Switch local routing for Claude Code. For Claude Desktop, select its model mapping mode and keep the app and CC Switch routing service running.

The gateway listens on loopback ports `15971` (domestic) and `15972` (international). It binds only to `127.0.0.1`; each request requires a random API key stored in the macOS Keychain. WorkBuddy account tokens stay in the app's Application Support directory and are never passed to Claude or CC Switch.

## Client access: CC Switch or direct connection

Each client (Claude Code / Claude Desktop / Codex) can choose its access mode independently; upgrades default back to CC Switch and nothing is ever written into a client's config silently:

- **Through CC Switch** — unchanged: client → CC Switch → the gateway's OpenAI Chat Completions entry → WorkBuddy.
- **Proxied directly by the app** — the client talks to a protocol entry the gateway serves itself; the data path never touches CC Switch:

  | Client | Entry | Notes |
  |---|---|---|
  | Claude Code / Claude Desktop | `POST /v1/messages` | Anthropic Messages compatible: text, streaming (SSE), tool calls, error mapping, client-disconnect cancel |
  | Codex | `POST /v1/responses` | OpenAI Responses compatible: text, streaming, function calls; `reasoning.effort` is forwarded only when the catalog confirms support |
  | Diagnostics | `GET /bridge/status` | Protocol state, access modes, model-mapping inventory and stale mappings (requires the API key) |

  Both entries reuse the same upstream pipeline as Chat Completions — credential refresh, account-pool failover, tool-call recovery and log hygiene run once, in the pipeline that already owns them.

Claude Code direct example (environment variables; the key comes from the app):

```sh
export ANTHROPIC_BASE_URL=http://127.0.0.1:15972
export ANTHROPIC_AUTH_TOKEN=<local API key from the app>
export ANTHROPIC_MODEL=claude-sonnet-4-5-20250929
```

Codex direct example (`~/.codex/config.toml`):

```toml
[model_providers.workbuddy]
name = "WorkBuddy Model Bridge"
base_url = "http://127.0.0.1:15972/v1"
wire_api = "responses"
env_key = "WORKBUDDY_BRIDGE_API_KEY"
```

### Model mapping

The model key a client sends (an alias, an official id, or a role) is resolved to a REAL WorkBuddy model id; display names are never mistaken for upstream ids. Mappings and per-client access modes persist in `bridge-config.json` inside the app data directory:

```json
{
  "schemaVersion": 1,
  "accessModes": [
    { "client": "claude-code", "region": "cn", "mode": "ccswitch" }
  ],
  "modelMappings": [
    {
      "client": "claude-code",
      "region": "cn",
      "modelKey": "claude-sonnet-4-5-20250929",
      "displayName": "WorkBuddy Chat",
      "modelId": "wb-chat-cn",
      "enabled": true
    }
  ]
}
```

Resolution order: exact mapping → catalog pass-through (the key IS a real id) → Claude role (`claude-sonnet-*` → `sonnet`) → the client's default mapping (`modelKey` empty) → the region's only model. Failures are readable errors listing servable models, never silent reroutes; a mapping whose target left the catalog is kept and flagged for rebinding. Edits made by the app UI take effect without restarting the gateway; a corrupt file makes the gateway run on defaults and report the recovery path on `/bridge/status`, never overwriting the broken file.

### Privacy and security (direct mode)

- The protocol entries bind `127.0.0.1` only and share the same local key and loopback guards (Host/Origin/Bearer) as Chat Completions.
- The `x-workbuddy-resolved-model` response header says which upstream id served the request; diagnostics never contain tokens, prompts or response bodies.
- Switching access modes only changes what the gateway displays and how it guides setup — it never writes CC Switch, Claude or Codex config files, and switching back needs no cleanup.

See [docs/SUPPORT-MATRIX.md](docs/SUPPORT-MATRIX.md) for protocol boundaries and the verified / not-yet-verified scope.

## Current scope

- The app runs independently of DeepSeek Harness and does not invoke WorkBuddy CLI.
- The app discovers WorkBuddy's local desktop credentials, refreshes tokens through the existing store, reads model catalogs, and starts one secured endpoint per region.
- The direct-connection entries (`/v1/messages`, `/v1/responses`) are implemented and covered by fixture/integration tests; end-to-end acceptance against real Claude Code, Claude Desktop and Codex is still pending (see the support matrix).
- Claude Desktop direct-profile management, an installer-grade Windows EXE, and macOS `.dmg` delivery proceed in phases per the development plan; this repository currently carries the shared gateway and protocol layers, not those platform artifacts.
- Claude's harness owns tool execution and local task work; WorkBuddy supplies model inference through its subscription.
- Anthropic extended thinking (`thinking`) is not forwarded; such requests get an explicit error. Upstream reasoning tiers are forwarded through the Responses entry according to catalog capability.
## Windows app

On Windows 10/11 with .NET Framework 4.8 and Node.js ^22.19.0 or >=24, run `npm install`, `npm run typecheck`, then `./windows/build-app.ps1` from PowerShell. See [the Windows build instructions](README.md#构建-windows-应用). Follow your organization's script approval process if execution policy blocks scripts; the build does not change system policy.

The script compiles a native WinForms EXE and packages it with Node, the shared gateway and licenses in a timestamped `windows/build/` directory and portable ZIP. Extract the whole ZIP before launching the EXE. Closing the window keeps the app in the tray; Quit closes its owned gateway through a private stdin pipe. Both regional endpoints, sign-in state and models are shown, with buttons to copy URLs and API keys. Keys are encrypted using DPAPI CurrentUser in `%LOCALAPPDATA%/WorkBuddy Model Bridge`. The existing credential layer's Windows ACL hardening runs during real gateway use; restricted environments need approval for that runtime behavior. No installer, signing or automatic updates are included. Real-account inference has not been verified; [verification details](windows/VERIFICATION.md).
