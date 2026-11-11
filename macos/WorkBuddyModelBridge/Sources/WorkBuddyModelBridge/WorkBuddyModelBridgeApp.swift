import SwiftUI
import AppKit

@main
struct WorkBuddyModelBridgeApp: App {
    @NSApplicationDelegateAdaptor(WorkBuddyModelBridgeAppDelegate.self) private var appDelegate
    @StateObject private var gateway = GatewayController()

    var body: some Scene {
        WindowGroup(id: "main") {
            ContentView(gateway: gateway)
                .frame(minWidth: 920, minHeight: 650)
                .task {
                    appDelegate.stopGateway = { gateway.stop() }
                    gateway.start()
                }
        }
        .windowStyle(.hiddenTitleBar)
        .defaultSize(width: 1040, height: 720)
        .commands {
            CommandGroup(replacing: .newItem) {}
        }

        MenuBarExtra {
            GatewayMenu(gateway: gateway)
        } label: {
            Image(systemName: "sparkles")
        }
        .menuBarExtraStyle(.menu)
    }
}

@MainActor
private final class WorkBuddyModelBridgeAppDelegate: NSObject, NSApplicationDelegate {
    var stopGateway: (() -> Void)?

    func applicationWillTerminate(_ notification: Notification) {
        stopGateway?()
    }
}

private struct GatewayMenu: View {
    @ObservedObject var gateway: GatewayController
    @Environment(\.openWindow) private var openWindow

    var body: some View {
        Button("打开主窗口") {
            openWindow(id: "main")
        }

        switch gateway.state {
        case .running:
            Label("本地网关运行中", systemImage: "checkmark.circle.fill")
            Button("停止本地网关") { gateway.stop() }
        case .starting:
            Label("本地网关正在启动", systemImage: "hourglass")
            Button("停止本地网关") { gateway.stop() }
        case .failed(_):
            Label("本地网关启动失败", systemImage: "exclamationmark.triangle.fill")
            Button("重新启动本地网关") { gateway.start() }
        case .stopped:
            Label("本地网关已停止", systemImage: "pause.circle")
            Button("启动本地网关") { gateway.start() }
        }

        Divider()
        Button("退出 WorkBuddy Model Bridge") {
            NSApplication.shared.terminate(nil)
        }
    }
}
