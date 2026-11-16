# Mac 封装说明（老板在 Mac 上执行）

需求 §9.2：Win-A 交付共享源码、网关产物/构建说明与本清单；**不**交付 macOS `.app`/`.dmg` 成品。Mac 上的 Xcode 构建、安装检查、DMG 生成、签名/公证全部由你在 Mac 上完成。

## 本轮新增了什么（Mac 外壳视角）

- 网关新增两个直连协议入口：`POST /v1/messages`（Anthropic Messages）与 `POST /v1/responses`（OpenAI Responses），以及诊断端点 `GET /bridge/status`。SwiftUI 外壳**无需改动**即可继续工作；这些入口与既有 Chat Completions 共享同一管道、同一把本地 key。
- 网关新增配置文件读取：`<Application Support>/WorkBuddy Model Bridge/bridge-config.json`（每客户端接入方式 + 模型映射）。文件由 UI（或手工）写入，网关每次请求重读，改完即生效，无需重启。文件损坏时网关按默认值运行并在 `/bridge/status` 报出原因，不会覆盖坏文件。
- 共享 TS 源码：`src/protocol/`、`src/model-mapping.ts`、`src/bridge-config.ts`，随 `npm run build` 进入 `lib/macGateway.js`，对 Xcode 工程透明。

## Mac 侧构建步骤（每轮发版照此执行）

1. 同步本仓库到 Mac（`git pull` 本分支）。
2. 构建网关产物（Node ≥ 22.19 或 ≥ 24）：

   ```sh
   npm install
   npm run build        # 产出 lib/macGateway.js
   npm test             # 47 项测试应全绿
   ```

3. 构建 .app（复用既有脚本，它会先跑 `npm run build` 再编译 Swift 并打包 Node 运行时）：

   ```sh
   bash macos/build-app.sh
   ```

4. Xcode 打开 `macos/WorkBuddyModelBridge/Package.swift` 检查（可选）：确认 `GatewayController` 启动的网关进程与打包的 Node 运行时没有变化——本轮没有改 Swift 源码。
5. 手工验收（建议逐条记录）：
   - 应用启动后，`curl -H "Authorization: Bearer <本地key>" http://127.0.0.1:15971/bridge/status` 返回 `protocols` 里含 `anthropic-messages: true`、`openai-responses: true`；国际版用 15972。
   - （可选，有真实客户端时）Claude Code 设 `ANTHROPIC_BASE_URL=http://127.0.0.1:15971` + `ANTHROPIC_AUTH_TOKEN=<本地key>` 发一轮对话，确认 `x-workbuddy-resolved-model` 响应头出现。
6. 生成 DMG（任选其一）：
   - `hdiutil create -volname "WorkBuddy Model Bridge" -srcfolder "macos/build/WorkBuddy Model Bridge.app" -ov -format UDZO "macos/build/WorkBuddy Model Bridge.dmg"`
   - 或用你惯用的 DMG 工具（如 `create-dmg`），保持「拖入应用程序」布局。
7. 签名/公证/stapling 按你的发布流程处理；未签名版本请如实标注「开发/验收版」。

## 记录要求（需求 §9.3）

- Mac 侧验收记录需包含：实测 macOS 版本、CPU 架构（Apple Silicon / Intel，以实际构建为准）、Xcode 版本、`.app`/`.dmg` 是否安装成功、直连入口是否可用。
- Win-A 报告只声称「macOS 源码已准备」；「Mac 上 Xcode/DMG 已实测」以你的记录为准。发布资产按实际完成范围标注。
