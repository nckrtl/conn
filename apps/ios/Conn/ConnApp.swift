import DesignKit
import SwiftUI

@main
struct ConnApp: App {
    @State private var store = CoreStore()
    @Environment(\.scenePhase) private var scenePhase

    var body: some Scene {
        WindowGroup {
            Group {
                if store.isPaired {
                    InboxView(store: store)
                } else {
                    PairingView(store: store)
                }
            }
            .kitAppearance()
            .onChange(of: scenePhase) { _, newPhase in
                store.handleScenePhase(newPhase)
            }
        }
    }
}
