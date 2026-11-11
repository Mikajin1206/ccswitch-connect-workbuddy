import SwiftUI

struct ContentView: View {
    @ObservedObject var gateway: GatewayController
    @State private var selectedSection = "概览"
    @State private var revealKey = false

    private let sections = ["概览", "模型服务", "接入说明"]

    var body: some View {
        HStack(spacing: 0) {
            sidebar
            Rectangle().fill(Color.white.opacity(0.07)).frame(width: 1)
            ScrollView {
                VStack(alignment: .leading, spacing: 24) {
                    header
                    switch selectedSection {
                    case "模型服务": models
                    case "接入说明": instructions
                    default: overview
                    }
                }
                .padding(32)
                .frame(maxWidth: 820, alignment: .leading)
                .frame(maxWidth: .infinity, alignment: .leading)
            }
            .background(Color(nsColor: .windowBackgroundColor))
        }
        .preferredColorScheme(.dark)
    }

    private var sidebar: some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack(spacing: 12) {
                ZStack {
                    RoundedRectangle(cornerRadius: 12).fill(LinearGradient(colors: [Color(red: 0.45, green: 0.68, blue: 1), Color(red: 0.32, green: 0.43, blue: 0.9)], startPoint: .topLeading, endPoint: .bottomTrailing))
                    Image(systemName: "point.3.connected.trianglepath.dotted").font(.system(size: 17, weight: .semibold)).foregroundStyle(.white)
                }.frame(width: 38, height: 38)
                VStack(alignment: .leading, spacing: 2) {
                    Text("WorkBuddy").font(.system(size: 14, weight: .semibold))
                    Text("MODEL BRIDGE").font(.system(size: 9, weight: .bold, design: .rounded)).tracking(1.2).foregroundStyle(.secondary)
                }
            }
            .padding(.bottom, 24)

            ForEach(sections, id: \.self) { section in
                Button { selectedSection = section } label: {
                    HStack(spacing: 10) {
                        Image(systemName: icon(for: section)).frame(width: 18)
                        Text(section)
                        Spacer()
                    }
                    .font(.system(size: 13, weight: selectedSection == section ? .semibold : .regular))
                    .foregroundStyle(selectedSection == section ? .primary : .secondary)
                    .padding(.horizontal, 12)
                    .padding(.vertical, 10)
                    .background(selectedSection == section ? Color.white.opacity(0.09) : .clear, in: RoundedRectangle(cornerRadius: 9))
                }
                .buttonStyle(.plain)
            }
            Spacer()
            HStack(spacing: 8) {
                Circle().fill(statusColor).frame(width: 7, height: 7)
                Text(statusText).font(.system(size: 11)).foregroundStyle(.secondary)
            }.padding(.horizontal, 12).padding(.bottom, 4)
        }
        .padding(18)
        .frame(width: 220)
        .background(Color(nsColor: .underPageBackgroundColor))
    }

    private var header: some View {
        VStack(alignment: .leading, spacing: 7) {
            Text(selectedSection).font(.system(size: 28, weight: .bold, design: .rounded))
            Text("将 WorkBuddy 订阅模型接入 Claude 的本地模型路由。任务和工具仍由 Claude harness 执行。")
                .font(.system(size: 13)).foregroundStyle(.secondary)
        }
    }

    private var overview: some View {
        VStack(alignment: .leading, spacing: 18) {
            HStack(spacing: 16) {
                Image(systemName: gateway.isRunning ? "wave.3.right" : "pause.circle")
                    .font(.system(size: 22, weight: .medium))
                    .foregroundStyle(gateway.isRunning ? Color.green : Color.secondary)
                    .frame(width: 48, height: 48)
                    .background((gateway.isRunning ? Color.green : Color.gray).opacity(0.12), in: RoundedRectangle(cornerRadius: 14))
                VStack(alignment: .leading, spacing: 4) {
                    Text(gateway.isRunning ? "本地网关正在运行" : "本地网关已停止").font(.system(size: 16, weight: .semibold))
                    Text(statusDetail).font(.system(size: 12)).foregroundStyle(.secondary)
                }
                Spacer()
                Button(gateway.isRunning ? "停止服务" : "启动服务") {
                    gateway.isRunning ? gateway.stop() : gateway.start()
                }
                .buttonStyle(.borderedProminent)
                .tint(gateway.isRunning ? .gray : .blue)
                .disabled(gateway.state == .starting)
            }
            .padding(20)
            .background(Color(nsColor: .controlBackgroundColor), in: RoundedRectangle(cornerRadius: 16))

            if case .failed(let message) = gateway.state {
                Label(message, systemImage: "exclamationmark.triangle.fill")
                    .font(.system(size: 12)).foregroundStyle(.orange)
                    .padding(14).frame(maxWidth: .infinity, alignment: .leading)
                    .background(Color.orange.opacity(0.09), in: RoundedRectangle(cornerRadius: 12))
            }

            HStack(spacing: 12) {
                metric(title: "服务区域", value: "\(gateway.endpoints.count) 个")
                metric(title: "WorkBuddy 账号", value: "\(gateway.endpoints.reduce(0) { $0 + $1.accountCount }) 个")
                metric(title: "可用模型", value: "\(gateway.endpoints.reduce(0) { $0 + $1.modelCount }) 个")
            }

            Text("接入地址").font(.system(size: 14, weight: .semibold))
            ForEach(gateway.endpoints) { endpointCard($0) }

            if gateway.isRunning {
                Label("请求只监听本机回环地址；访问密钥保存在 macOS 钥匙串。", systemImage: "lock.shield")
                    .font(.system(size: 11)).foregroundStyle(.secondary).padding(.top, 2)
            }
        }
    }

    private var models: some View {
        VStack(alignment: .leading, spacing: 16) {
            ForEach(gateway.endpoints) { endpoint in
                VStack(alignment: .leading, spacing: 10) {
                    HStack {
                        Text(endpoint.displayRegion).font(.system(size: 16, weight: .semibold))
                        Spacer()
                        Text(endpoint.signedIn ? "\(endpoint.accountCount) 个账号 · \(endpoint.models.count) 个模型" : "未发现登录账号")
                            .font(.system(size: 11)).foregroundStyle(.secondary)
                    }
                    if endpoint.models.isEmpty {
                        Text(endpoint.signedIn ? "模型目录暂不可用。重启网关以重新读取目录。" : "请先在 WorkBuddy 桌面端登录该区域账号。")
                            .font(.system(size: 12)).foregroundStyle(.secondary)
                    } else {
                        ForEach(endpoint.models) { model in
                            HStack(spacing: 10) {
                                Image(systemName: "sparkle").foregroundStyle(.blue)
                                Text(model.name).font(.system(size: 12, weight: .medium))
                                Text(model.id).font(.system(size: 10, design: .monospaced)).foregroundStyle(.secondary)
                                Spacer()
                                if let multiplier = model.multiplier {
                                    Text(String(format: "×%.2f", multiplier)).font(.system(size: 10, design: .rounded)).foregroundStyle(.secondary)
                                }
                            }.padding(.vertical, 4)
                        }
                    }
                }
                .padding(18)
                .background(Color(nsColor: .controlBackgroundColor), in: RoundedRectangle(cornerRadius: 14))
            }
        }
    }

    private var instructions: some View {
        VStack(alignment: .leading, spacing: 16) {
            instruction(number: "01", title: "添加自定义 provider", text: "在 CCSwitch 的 Claude Code 或 Claude Desktop 配置中添加一个自定义供应商。")
            instruction(number: "02", title: "选择 OpenAI Chat Completions", text: "将上游协议设为 OpenAI Chat Completions；CCSwitch 负责把 Claude Messages 请求转换为 WorkBuddy 网关可接收的格式。")
            instruction(number: "03", title: "填写本区域端点和访问密钥", text: "端点与 API Key 可在“概览”页复制。国内版和国际版是两个独立 provider。")
            instruction(number: "04", title: "保持本地网关运行", text: "Claude Code / Claude Desktop → CCSwitch 本地路由 → WorkBuddy Model Bridge → WorkBuddy。关闭主窗口后 App 会留在菜单栏继续服务；退出 App 后本地端点停止。")
            Text("这个接入使用 WorkBuddy 订阅额度；Claude 负责工具循环、文件操作和任务执行。Anthropic 不保证对非 Claude 上游模型的网关兼容。")
                .font(.system(size: 11)).foregroundStyle(.secondary)
                .padding(16).frame(maxWidth: .infinity, alignment: .leading)
                .background(Color.blue.opacity(0.08), in: RoundedRectangle(cornerRadius: 12))
        }
    }

    private var statusColor: Color {
        switch gateway.state {
        case .running: .green
        case .starting: .orange
        case .failed: .red
        case .stopped: .gray
        }
    }

    private var statusText: String {
        switch gateway.state {
        case .running: "网关在线"
        case .starting: "正在启动"
        case .failed: "启动失败"
        case .stopped: "网关离线"
        }
    }

    private var statusDetail: String {
        switch gateway.state {
        case .running: "服务已绑定 127.0.0.1，仅本机应用可访问。"
        case .starting: "正在扫描 WorkBuddy 登录态并读取模型目录…"
        case .failed: "网关未能启动，请查看下面的错误信息。"
        case .stopped: "启动后，CCSwitch 可将请求路由到本机服务。"
        }
    }

    private func metric(title: String, value: String) -> some View {
        VStack(alignment: .leading, spacing: 6) {
            Text(title).font(.system(size: 11)).foregroundStyle(.secondary)
            Text(value).font(.system(size: 18, weight: .semibold, design: .rounded))
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(16)
        .background(Color(nsColor: .controlBackgroundColor), in: RoundedRectangle(cornerRadius: 13))
    }

    private func endpointCard(_ endpoint: GatewayEndpoint) -> some View {
        VStack(alignment: .leading, spacing: 12) {
            HStack {
                VStack(alignment: .leading, spacing: 3) {
                    Text(endpoint.displayRegion).font(.system(size: 14, weight: .semibold))
                    Text(endpoint.signedIn ? "账号已连接" : "等待 WorkBuddy 登录")
                        .font(.system(size: 11)).foregroundStyle(endpoint.signedIn ? .green : .secondary)
                }
                Spacer()
                Button { gateway.copy(endpoint.baseUrl) } label: { Label("复制地址", systemImage: "doc.on.doc") }
                    .buttonStyle(.bordered)
                    .disabled(!gateway.isRunning)
            }
            LabeledValue(label: "Base URL", value: endpoint.baseUrl)
            LabeledValue(label: "API Key", value: revealKey ? endpoint.apiKey : String(repeating: "•", count: 20))
            HStack {
                Button(revealKey ? "隐藏密钥" : "显示密钥") { revealKey.toggle() }.buttonStyle(.plain)
                Button { gateway.copy(endpoint.apiKey) } label: { Label("复制密钥", systemImage: "key.horizontal") }.buttonStyle(.plain)
                Spacer()
                Text("协议：OpenAI Chat Completions").font(.system(size: 10)).foregroundStyle(.tertiary)
            }
            .font(.system(size: 11))
            .disabled(!gateway.isRunning)
        }
        .padding(18)
        .background(Color(nsColor: .controlBackgroundColor), in: RoundedRectangle(cornerRadius: 14))
    }

    private func instruction(number: String, title: String, text: String) -> some View {
        HStack(alignment: .top, spacing: 14) {
            Text(number).font(.system(size: 12, weight: .bold, design: .rounded)).foregroundStyle(.blue)
                .frame(width: 34, height: 34).background(Color.blue.opacity(0.12), in: RoundedRectangle(cornerRadius: 10))
            VStack(alignment: .leading, spacing: 5) {
                Text(title).font(.system(size: 13, weight: .semibold))
                Text(text).font(.system(size: 12)).foregroundStyle(.secondary).fixedSize(horizontal: false, vertical: true)
            }
            Spacer(minLength: 0)
        }.padding(16).background(Color(nsColor: .controlBackgroundColor), in: RoundedRectangle(cornerRadius: 13))
    }

    private func icon(for section: String) -> String {
        switch section {
        case "模型服务": "square.stack.3d.up"
        case "接入说明": "arrow.triangle.branch"
        default: "square.grid.2x2"
        }
    }
}

private struct LabeledValue: View {
    let label: String
    let value: String

    var body: some View {
        HStack(spacing: 12) {
            Text(label).font(.system(size: 10, weight: .semibold)).foregroundStyle(.secondary).frame(width: 55, alignment: .leading)
            Text(value).font(.system(size: 11, design: .monospaced)).textSelection(.enabled).lineLimit(1)
            Spacer(minLength: 0)
        }
    }
}
