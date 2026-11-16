# 协议支持矩阵（双接入模式）

对应《DEVELOPMENT-REQUIREMENTS》§11「支持矩阵列出 app/客户端版本、协议、已验证能力和限制」。日期：2026-11-16；基线：`feat/windows-native-app` + 本分支。

**诚实边界**：本仓库目前的验证手段是 TypeScript 类型检查、47 项单测/fixture/集成测试和真实网关进程内的回环链路测试（伪造上游、真 HTTP、真端口、真协议帧）。**还没有**用真实 Claude Code / Claude Desktop / Codex 客户端对真实 WorkBuddy 账号做过端到端验收——下表「已验证」均指本轮测试手段覆盖的程度，不得解读成真实客户端验收已完成。

## 协议入口

| 入口 | 状态 | 已验证（本轮测试手段） | 未验证 |
|---|---|---|---|
| `POST /v1/chat/completions`（既有） | 保留不动 | 既有生产链路（CC Switch 消费） | — |
| `POST /v1/messages`（Anthropic Messages） | 新增 | 请求转换 fixture（system/图片/工具/工具结果/stop 序列/错误信封）、流式事件序列、聚合、真实 shim HTTP 集成、回环防护（401/403）、模型解析 | 真实 Claude Code / Claude Desktop 端到端；真实账号推理 |
| `POST /v1/responses`（OpenAI Responses） | 新增 | 请求转换 fixture（instructions/函数调用/工具结果/reasoning 档位门控）、流式事件、聚合、真实 shim HTTP 集成 | 真实 Codex 端到端；`wire_api = "responses"` 在目标 Codex 版本上的实测 |
| `GET /bridge/status` | 新增 | 集成测试：协议清单、接入方式、映射清点、配置热生效 | — |
| `GET /healthz`、`GET /v1/models` | 保留不动 | 既有 | — |

## 客户端 × 接入方式

| 客户端 | CC Switch 模式 | 直连模式 | 备注 |
|---|---|---|---|
| Claude Code | 既有链路，未改动 | `/v1/messages` 已实现；`ANTHROPIC_BASE_URL/ANTHROPIC_AUTH_TOKEN` 配置写进 README；端到端待真实客户端验收 | 模型键可以是自定义别名，经映射解析到真实 id |
| Claude Desktop | 既有链路，未改动 | `/v1/messages` 已实现（角色映射 `opus`/`sonnet`/`haiku`）；**profile 直连配置管理未实现**（阶段 D，需先确认当前 Desktop 版本的第三方配置机制） | 在此之前 Desktop 直连只能手工改配置，本应用绝不代写 Desktop 配置 |
| Codex | 既有链路，未改动 | `/v1/responses` 已实现；`config.toml` provider 片段写进 README；端到端待真实客户端验收 | 若实测 Codex 目标版本 `wire_api = "chat"` 更稳，可改走既有 Chat Completions 入口（配置层切换，无需新代码） |

## 能力边界（按需求「不支持的字段要明确报错」实现）

| 请求字段/能力 | 行为 |
|---|---|
| Anthropic `thinking`（扩展思考） | **明确拒绝**（400，说明原因），不静默丢弃、不伪造推理能力 |
| Responses `reasoning.effort` | 目录 `supportedEfforts` 确认支持 → 转发为 `reasoning_effort`；目录未声明 → 省略并置 `x-workbuddy-reasoning-note` 头说明；目录明确不支持 → 400 并列出支持档位 |
| Anthropic `image` 块 | 转换为 OpenAI 视觉格式转发；真实上游对视觉输入的支持未实测 |
| 工具结果里的图片 | 转为文本占位说明（`tool` 角色消息体是纯文本），不静默丢弃 |
| Anthropic `tool_choice` | `auto`/`any`/`none`/`tool` 全部映射；其它形状 400 |
| 模型键解析失败 | 400 + 可用模型清单；映射目标失效时提示重新绑定，绝不静默改道 |
| 上游流中断 | Anthropic 发 `event: error`，Responses 发 `response.failed`；客户端断连取消整条链路 |

## 模型映射解析顺序

1. 精确映射（client + region + modelKey，`claude-code` 优先于 `claude-desktop`——`/v1/messages` 无法从协议区分两者，顺序固定保证确定性）；
2. 目录直通（请求键就是真实模型 id）；
3. Claude 角色归一（仅 `claude-opus/sonnet/haiku` 前缀；Codex 键不做角色归一）；
4. 客户端默认映射（`modelKey: ""`）；
5. 区域唯一模型；
6. 可读失败（列出可用模型）。

## 配置持久化保证（需求 §8）

- 升级后默认 CC Switch：`accessModes` 缺行 = `ccswitch`；文件缺失 = 全默认。
- 原子写：`.tmp` + rename，读侧永远看到完整文件。
- 损坏文件：读取报可读错误（含修复方式），网关按默认值继续运行，`/bridge/status` 报告错误；**拒绝写入**以保留现场。
- 热生效：协议入口每次请求重读配置文件（网关是子进程，应用 UI 写文件后无需重启）。
- 带 BOM 的配置文件照常读取（Windows 编辑器常见）。

## 平台交付边界（需求 §9）

- 本仓库当前交付：共享网关 + 协议层 + 映射/配置层 + 测试 + 文档。
- Windows：便携版 EXE 打包已在 `feat/windows-native-app` 完成（未签名、无安装器）；安装器化、升级保留、Credential Manager 凭据实测（阶段 D）未做。
- macOS：SwiftUI 源码未改（本轮协议能力对 Swift 外壳透明，`/bridge/status` 可作为接入设置 UI 的数据源）；Xcode 构建、`.app`/`.dmg`、签名/公证由 Mac 侧完成，见 [MAC-PACKAGING.md](MAC-PACKAGING.md)。
