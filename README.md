# WorkBuddy Model Bridge（macOS / Windows）

一个原生 SwiftUI macOS 应用，把本机已登录的 WorkBuddy 订阅模型接入 Claude Code、Claude Desktop 与 Codex——既可以通过 CC Switch 接入，也可以由应用直连代理。English: [README.en.md](README.en.md).

## 原作者与移植说明

原始 DSH 插件由 **LaoDing（老丁，GitHub [`dingminhua`](https://github.com/dingminhua)）** 创建，遵循本项目的 [MIT 许可证](LICENSE)。感谢原作者开源 WorkBuddy 接入实现。本项目是单独维护的 macOS 移植；DSH 插件仓库仍独立存在。

本项目复用原仓库中的凭据发现与刷新、区域模型目录、上游客户端和本地安全 shim。新增的 `src/mac-gateway.ts` 是独立网关入口：按国内、国际区域分别启动本地服务，不依赖 DSH 宿主，也不调用 WorkBuddy CLI。SwiftUI 应用启动随包提供的 Node 运行时和网关，将本地随机 API key 存入 macOS 钥匙串，并把 WorkBuddy 凭据保存在用户的 Application Support 目录。

请求链路为：**Claude harness → CC Switch → 本地 WorkBuddy 网关 → WorkBuddy 订阅模型**。CC Switch 将 Claude Messages 请求转换为 OpenAI Chat Completions 格式；WorkBuddy 订阅提供模型推理，Claude harness 负责任务执行、工具调用和本地文件操作。

图标基于 WorkBuddy 应用图标修改。WorkBuddy 与相关商标归各自权利人所有；本项目与 WorkBuddy/Tencent 无隶属或背书关系。

## 构建 macOS 应用

需要 macOS 14 或更新版本、Xcode 27.2 或更新版本、Node.js 22 或更新版本及 pnpm。

```sh
pnpm install
bash macos/build-app.sh
```

构建结果为 `macos/build/WorkBuddy Model Bridge.app`，并生成可安装压缩包 `macos/build/WorkBuddy Model Bridge.zip`。压缩包中的 `.app` 可解压后拖入“应用程序”。应用包会携带构建机器上的 Node 运行时与已编译网关。SwiftUI 源码位于 `macos/WorkBuddyModelBridge`，可用 Xcode 打开。

应用打开主窗口时启动本地网关。关闭窗口后应用和网关继续运行；可通过菜单栏的 sparkles 菜单重新打开窗口、停止或启动网关，或退出应用。退出应用会停止网关。

## 构建 Windows 应用

Windows 10/11、.NET Framework 4.8、Node.js 22.19 或更新版本。在仓库根目录执行：

```powershell
npm install
npm run typecheck
.\windows\build-app.ps1
```

脚本复用 TypeScript 网关，使用系统自带的 .NET Framework C# 编译器构建原生 WinForms 外壳，无需安装 Visual Studio。产物位于 `windows/build/<时间戳>/WorkBuddy Model Bridge/`，包含 `WorkBuddy Model Bridge.exe`、Node 运行时与网关，旁边生成便携式 ZIP 和输出 SHA256。请完整解压 ZIP 后运行 EXE，不能只复制 EXE。Node 的架构与构建机器一致；当前验证环境为 Windows x64。此版本未签名，未提供安装器或自动更新。

与 Mac 版一致，打开应用自动启动网关，显示国内/国际端点、登录状态和模型列表，可复制 Base URL 和 API Key。关闭窗口后留在托盘；托盘可重新打开、启动、停止或退出。退出通过私有管道通知自有网关关闭，不操作其他服务。启动失败只显示通用错误，不写入包含凭据的日志。已有 WorkBuddy 登录状态由共享凭据发现逻辑读取。

应用数据位于 `%LOCALAPPDATA%\WorkBuddy Model Bridge`，本地 API key 使用 Windows DPAPI `CurrentUser` 加密保存（对应 Mac 钥匙串）；不会修改系统执行策略、防火墙或安装权限。运行时共享凭据层原有的目录 ACL 加固仍会执行，受限环境需由管理员按组织要求审批后运行。自动化验证只使用模拟网关，不读取真实凭据或执行 ACL 修改。

系统若禁止 PowerShell 脚本，请遵循组织的脚本审核流程；不要为构建降低全局执行策略。开发者可运行 `.\windows\test-app.ps1 -AppPath '<构建目录>\WorkBuddy Model Bridge.exe'` 验证窗口、协议校验、关闭到托盘与子进程停止行为。

## Node 网关构建（Windows / macOS / Linux）

Node 侧构建在 Windows、macOS、Linux 上都能运行：

```sh
npm install
npm run build
```

产物为 `lib/macGateway.js`。SwiftUI 应用外壳只能在 macOS 上构建，因为需要 Xcode；`macos/build-app.sh` 会先执行上述 `npm run build`，再编译并打包应用。

## 接入 CC Switch

1. 打开 **WorkBuddy Model Bridge**。应用会读取 WorkBuddy 桌面端登录状态，并分别显示国内版与国际版端点。
2. 在 CC Switch 中按使用区域添加 Claude provider。
3. 将上游 API 格式设为 **OpenAI Chat Completions**。
4. 填入应用“概览”页对应区域的 Base URL 和 API Key。
5. Claude Code 使用 CC Switch 本地路由。Claude Desktop 按 CC Switch 中对应的模型映射方式配置，并保持应用及 CC Switch 路由服务运行。

网关只监听回环地址 `127.0.0.1`：国内版端口为 `15971`，国际版端口为 `15972`。每个请求都要通过随机 API key 验证，该 key 保存在 macOS 钥匙串或 Windows DPAPI 加密文件中。WorkBuddy 账户 token 留在应用数据目录，不会传给 Claude 或 CC Switch。

## 客户端接入：CC Switch 与应用直连

每个客户端（Claude Code / Claude Desktop / Codex）都可以独立选择接入方式，互不影响，升级后默认仍是 CC Switch：

- **通过 CC Switch**：既有链路不变——客户端 → CC Switch → 网关的 OpenAI Chat Completions 入口 → WorkBuddy。CC Switch 继续负责协议转换与供应商管理。
- **由应用直接代理**：客户端直连网关的对应协议入口，数据路径不经过 CC Switch。网关侧入口：

  | 客户端 | 入口 | 说明 |
  |---|---|---|
  | Claude Code / Claude Desktop | `POST /v1/messages` | Anthropic Messages 兼容：文本、流式（SSE）、工具调用、错误映射、客户端断连取消 |
  | Codex | `POST /v1/responses` | OpenAI Responses 兼容：文本、流式、函数调用；`reasoning.effort` 只在模型目录确认支持时转发 |
  | 诊断 | `GET /bridge/status` | 协议状态、接入方式、模型映射清点与失效映射列表（需 API key） |

  两个协议入口与 Chat Completions 共享同一上游管道（凭据刷新、账号池故障转移、工具调用恢复、日志脱敏都不复制、不重复执行）。

Claude Code 直连示例（环境变量方式，key 由应用提供）：

```sh
export ANTHROPIC_BASE_URL=http://127.0.0.1:15972
export ANTHROPIC_AUTH_TOKEN=<应用里的本地 API key>
export ANTHROPIC_MODEL=claude-sonnet-4-5-20250929
```

Codex 直连示例（`~/.codex/config.toml`）：

```toml
[model_providers.workbuddy]
name = "WorkBuddy Model Bridge"
base_url = "http://127.0.0.1:15972/v1"
wire_api = "responses"
env_key = "WORKBUDDY_BRIDGE_API_KEY"
```

### 模型映射

客户端发送的模型键（别名、官方 id 或角色）由网关解析成真实的 WorkBuddy 模型 id，显示名永远不会被当成上游 id。映射持久化在应用数据目录的 `bridge-config.json`（含每客户端接入方式），结构如下：

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
      "displayName": "工作台对话",
      "modelId": "wb-chat-cn",
      "enabled": true
    }
  ]
}
```

解析顺序：精确映射 → 目录直通（请求键就是真实 id）→ Claude 角色（`claude-sonnet-*` → `sonnet`）→ 客户端默认映射（`modelKey` 为空）→ 区域唯一模型。解析失败时报可读错误并列出可用模型，绝不静默改道；映射目标失效时保留配置并提示重新绑定。应用 UI 修改此文件后立即生效，无需重启网关；文件损坏时网关按默认值运行并在 `/bridge/status` 报出修复方式，绝不会覆盖坏文件。

### 隐私与安全边界（直连模式）

- 协议入口与 Chat Completions 同样只绑定 `127.0.0.1`，共用同一把本地 key 与同一套回环校验（Host/Origin/Bearer）。
- 响应头 `x-workbuddy-resolved-model` 说明本次请求实际使用的上游模型 id；诊断不含任何 token、prompt 或响应正文。
- 切换接入方式只影响网关展示与后续配置流程，不会写入 CC Switch、Claude 或 Codex 的配置文件；恢复 CC Switch 模式不需要删除任何映射。

协议支持边界与已验证/未验证范围见 [docs/SUPPORT-MATRIX.md](docs/SUPPORT-MATRIX.md)。

## 当前范围

- 应用独立于 DeepSeek Harness，不调用 WorkBuddy CLI。
- 应用发现 WorkBuddy 桌面凭据、刷新 token、读取模型目录，并按区域启动受保护的本地端点。
- 直连协议入口（`/v1/messages`、`/v1/responses`）已实现并通过 fixture/集成测试；对真实 Claude Code、Claude Desktop、Codex 的端到端验收仍在进行中（见支持矩阵）。
- Claude Desktop 的直连 profile 管理、安装器化 Windows EXE 与 macOS `.dmg` 交付按开发方案分阶段推进；当前仓库包含共享网关与协议层，不包含上述平台成品。
- Claude harness 执行工具与本地任务；WorkBuddy 订阅仅提供模型推理。
- Anthropic 扩展思考（`thinking`）暂不支持透传，请求会得到明确错误；上游推理档位经 Responses 入口按目录能力转发。

## 第三方声明

详见 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)。
