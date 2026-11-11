import Foundation
import AppKit
import Security

struct GatewayEndpoint: Decodable, Identifiable {
    let region: String
    let baseUrl: String
    let apiKey: String
    let signedIn: Bool
    let accountCount: Int
    let modelCount: Int
    let models: [GatewayModel]

    var id: String { region }
    var displayRegion: String { region == "cn" ? "国内版" : "国际版" }
}

struct GatewayModel: Decodable, Identifiable {
    let id: String
    let name: String
    let multiplier: Double?
}

private struct GatewayReadyMessage: Decodable {
    let kind: String
    let endpoints: [GatewayEndpoint]
}

@MainActor
final class GatewayController: ObservableObject {
    enum State: Equatable {
        case stopped
        case starting
        case running
        case failed(String)
    }

    @Published private(set) var state: State = .stopped
    @Published private(set) var endpoints: [GatewayEndpoint] = []
    @Published private(set) var apiKey = ""

    private var process: Process?
    private var outputTask: Task<Void, Never>?

    var isRunning: Bool { state == .running }

    func start() {
        guard process?.isRunning != true, state != .starting else { return }
        state = .starting
        endpoints = []
        do {
            let key = try KeychainStore.gatewayKey()
            apiKey = key
            let process = Process()
            process.executableURL = try nodeExecutable()
            process.arguments = [try gatewayScript().path]
            var childEnvironment = [
                "PATH": ProcessInfo.processInfo.environment["PATH"] ?? "/usr/bin:/bin:/usr/sbin:/sbin",
                "HOME": FileManager.default.homeDirectoryForCurrentUser.path,
                "WORKBUDDY_GATEWAY_API_KEY": key,
                "WORKBUDDY_GATEWAY_HOME": try supportDirectory().path,
            ]
            if let executable = ProcessInfo.processInfo.environment["WORKBUDDY_APP_EXECUTABLE"] {
                childEnvironment["WORKBUDDY_APP_EXECUTABLE"] = executable
            }
            process.environment = childEnvironment

            let output = Pipe()
            let errors = Pipe()
            process.standardOutput = output
            process.standardError = errors
            process.terminationHandler = { [weak self] child in
                Task { @MainActor in
                    guard self?.process === child else { return }
                    self?.process = nil
                    if self?.state == .starting {
                        let data = errors.fileHandleForReading.readDataToEndOfFile()
                        let message = String(data: data, encoding: .utf8)?.trimmingCharacters(in: .whitespacesAndNewlines)
                        self?.state = .failed(message?.isEmpty == false ? message! : "网关进程意外退出")
                    } else {
                        self?.state = .stopped
                        self?.endpoints = []
                    }
                }
            }

            try process.run()
            self.process = process
            outputTask = Task.detached { [weak self] in
                let handle = output.fileHandleForReading
                while !Task.isCancelled {
                    let data = handle.availableData
                    if data.isEmpty { break }
                    guard let line = String(data: data, encoding: .utf8) else { continue }
                    for record in line.split(whereSeparator: \.isNewline) {
                        await self?.consume(String(record))
                    }
                }
            }
        } catch {
            state = .failed(error.localizedDescription)
        }
    }

    func stop() {
        outputTask?.cancel()
        outputTask = nil
        guard let process, process.isRunning else {
            state = .stopped
            endpoints = []
            return
        }
        process.terminate()
        self.process = nil
        state = .stopped
        endpoints = []
    }

    func copy(_ value: String) {
        NSPasteboard.general.clearContents()
        NSPasteboard.general.setString(value, forType: .string)
    }

    private func consume(_ line: String) {
        guard let data = line.data(using: .utf8),
              let ready = try? JSONDecoder().decode(GatewayReadyMessage.self, from: data),
              ready.kind == "ready" else { return }
        endpoints = ready.endpoints
        state = .running
    }

    private func gatewayScript() throws -> URL {
        let bundled = Bundle.main.bundleURL.appendingPathComponent("Contents/Resources/Gateway/macGateway.js")
        if FileManager.default.fileExists(atPath: bundled.path) {
            return bundled
        }
        let source = URL(fileURLWithPath: #filePath)
            .deletingLastPathComponent()
            .deletingLastPathComponent()
            .deletingLastPathComponent()
            .deletingLastPathComponent()
            .deletingLastPathComponent()
            .appendingPathComponent("lib/macGateway.js")
        guard FileManager.default.fileExists(atPath: source.path) else {
            throw NSError(domain: "WorkBuddyModelBridge", code: 1, userInfo: [NSLocalizedDescriptionKey: "找不到网关运行文件，请先运行 macOS app 构建脚本。"])
        }
        return source
    }

    private func nodeExecutable() throws -> URL {
        let bundled = Bundle.main.bundleURL.appendingPathComponent("Contents/MacOS/node")
        if FileManager.default.isExecutableFile(atPath: bundled.path) { return bundled }
        for path in ["/opt/homebrew/bin/node", "/usr/local/bin/node", "/usr/bin/node"] where FileManager.default.isExecutableFile(atPath: path) {
            return URL(fileURLWithPath: path)
        }
        throw NSError(domain: "WorkBuddyModelBridge", code: 2, userInfo: [NSLocalizedDescriptionKey: "未找到 Node.js。开发版需要 Node.js 22 或更高版本。"])
    }

    private func supportDirectory() throws -> URL {
        let url = FileManager.default.homeDirectoryForCurrentUser
            .appendingPathComponent("Library/Application Support/WorkBuddy Model Bridge", isDirectory: true)
        try FileManager.default.createDirectory(at: url, withIntermediateDirectories: true, attributes: [.posixPermissions: 0o700])
        return url
    }
}

private enum KeychainStore {
    private static let service = "com.dingminhua.WorkBuddyModelBridge"
    private static let account = "local-gateway-api-key"

    static func gatewayKey() throws -> String {
        let query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: account,
            kSecReturnData as String: true,
            kSecMatchLimit as String: kSecMatchLimitOne,
        ]
        var result: CFTypeRef?
        let status = SecItemCopyMatching(query as CFDictionary, &result)
        if status == errSecSuccess, let data = result as? Data, let value = String(data: data, encoding: .utf8) {
            return value
        }
        guard status == errSecItemNotFound else {
            throw NSError(domain: NSOSStatusErrorDomain, code: Int(status), userInfo: [NSLocalizedDescriptionKey: "无法从钥匙串读取本地网关密钥"])
        }

        var bytes = [UInt8](repeating: 0, count: 32)
        let randomStatus = SecRandomCopyBytes(kSecRandomDefault, bytes.count, &bytes)
        guard randomStatus == errSecSuccess else {
            throw NSError(domain: NSOSStatusErrorDomain, code: Int(randomStatus), userInfo: [NSLocalizedDescriptionKey: "无法生成本地网关密钥"])
        }
        let value = Data(bytes).base64EncodedString()
            .replacingOccurrences(of: "+", with: "-")
            .replacingOccurrences(of: "/", with: "_")
            .replacingOccurrences(of: "=", with: "")
        var add = query
        add.removeValue(forKey: kSecReturnData as String)
        add.removeValue(forKey: kSecMatchLimit as String)
        add[kSecValueData as String] = Data(value.utf8)
        let addStatus = SecItemAdd(add as CFDictionary, nil)
        guard addStatus == errSecSuccess else {
            throw NSError(domain: NSOSStatusErrorDomain, code: Int(addStatus), userInfo: [NSLocalizedDescriptionKey: "无法保存本地网关密钥到钥匙串"])
        }
        return value
    }
}
