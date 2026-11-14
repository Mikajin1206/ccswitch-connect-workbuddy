# WorkBuddy Model Bridge（macOS）

一个原生 SwiftUI macOS 应用，通过 CC Switch 把本机已登录的 WorkBuddy 订阅模型接入 Claude Code 与 Claude Desktop。English: [README.en.md](README.en.md).

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

## Windows 与 Linux 上的构建

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

网关只监听回环地址 `127.0.0.1`：国内版端口为 `15971`，国际版端口为 `15972`。每个请求都要通过随机 API key 验证，该 key 保存在 macOS 钥匙串。WorkBuddy 账户 token 留在应用的 Application Support 目录，不会传给 Claude 或 CC Switch。

## 当前范围

- 应用独立于 DeepSeek Harness，不调用 WorkBuddy CLI。
- 应用发现 WorkBuddy 桌面凭据、刷新 token、读取模型目录，并按区域启动受保护的本地端点。
- 首个 macOS 版本暂不包含账户选择、账号池故障转移、积分、签到、图像/视频工具和模型目录编辑。
- Claude harness 执行工具与本地任务；WorkBuddy 订阅仅提供模型推理。
- Claude Desktop 的第三方模型映射和 Claude Code 网关配置取决于已安装的 CC Switch 与 Claude 版本。Anthropic 不支持将 Claude Code 路由到非 Claude 模型。

## 第三方声明

详见 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)。
