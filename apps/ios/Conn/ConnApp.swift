import DesignKit
import SwiftUI

@main
struct ConnApp: App {
    @UIApplicationDelegateAdaptor(ConnAppDelegate.self) private var appDelegate
    @State private var store: CoreStore
    @State private var push = PushRegistration.shared
    @Environment(\.scenePhase) private var scenePhase

    init() {
        Self.anchorPerfLog()
        ConnSymbols.install()
        perfMark(stage: "swift.symbols_installed")
        // Mobile's `HEADER_TITLE_STYLE`: every native header title is 18pt, weight 500.
        UINavigationBar.appearance().titleTextAttributes = [
            .font: UIFont.systemFont(ofSize: 18, weight: .medium),
        ]
        // Lab `.m-wsbar-tab`: idle tab icons in the muted foreground.
        UITabBar.appearance().unselectedItemTintColor = UIColor { traits in
            UIColor(ConnTheme.resolve(for: traits.userInterfaceStyle == .dark ? .dark : .light).mutedForeground)
        }
        let store = CoreStore()
        perfMark(stage: "swift.store_ready")
        _store = State(initialValue: store)
        // Push taps can arrive at launch, before the first view appears.
        ConnAppDelegate.store = store
    }

    /// Gives the Rust perf log (`CONN_PERF_LOG_FILE`) the process start, which its `sync.*`
    /// lines count from.
    private static func anchorPerfLog() {
        guard ProcessInfo.processInfo.environment["CONN_PERF_LOG_FILE"] != nil else { return }
        var info = kinfo_proc()
        var size = MemoryLayout<kinfo_proc>.stride
        var mib: [Int32] = [CTL_KERN, KERN_PROC, KERN_PROC_PID, getpid()]
        guard sysctl(&mib, 4, &info, &size, nil, 0) == 0 else { return }
        let start = info.kp_proc.p_un.__p_starttime
        perfSetProcessStart(epochMs: Double(start.tv_sec) * 1000 + Double(start.tv_usec) / 1000)
        perfMark(stage: "swift.app_init")
    }

    var body: some Scene {
        WindowGroup {
            ConnThemeProvider {
                Group {
                    // Rust's state decides: the full Orbit or pairing screen only until this
                    // scope has connected; after that a reconnect shows inline in the workspace.
                    if store.showsWorkspace {
                        WorkspaceRootView(store: store)
                            .alert("Couldn’t reach the Orbit server", isPresented: Binding(
                                get: { store.showsSavedConnectionAlert },
                                set: { _ in }
                            )) {
                                Button("Use offline") { store.useSavedWorkspaceOffline() }
                                Button("Try again") { store.retrySavedConnection() }
                            } message: {
                                Text("Check that https://gateway.orbit is available, then try again.")
                            }
                    } else if let orbitConnect = store.orbitConnect {
                        OrbitConnectView(store: store, state: orbitConnect)
                    } else {
                        PairingView(store: store)
                    }
                }
            }
            .kitAppearance()
            #if DEBUG && targetEnvironment(simulator)
            .preferredColorScheme(ProcessInfo.processInfo.environment["CONN_TEST_APPEARANCE"].flatMap {
                switch $0 { case "dark": .dark; case "light": .light; default: nil }
            })
            #endif
            .onChange(of: scenePhase) { _, newPhase in
                store.handleScenePhase(newPhase)
            }
            .onOpenURL { url in
                if let link = ThreadLink(url: url) {
                    store.open(link)
                }
            }
            .task {
                await push.start()
            }
            .sheet(isPresented: $push.showsExplainer) {
                PushExplainerSheet(
                    onTurnOn: { push.acceptExplainer() },
                    onNotNow: { push.declineExplainer() }
                )
            }
        }
    }
}
