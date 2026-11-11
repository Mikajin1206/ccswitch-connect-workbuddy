// swift-tools-version: 5.9
import PackageDescription

let package = Package(
    name: "WorkBuddyModelBridge",
    platforms: [.macOS(.v14)],
    products: [.executable(name: "WorkBuddyModelBridge", targets: ["WorkBuddyModelBridge"])],
    targets: [
        .executableTarget(
            name: "WorkBuddyModelBridge",
            path: "Sources/WorkBuddyModelBridge"
        ),
    ]
)
