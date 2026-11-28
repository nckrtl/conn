#if DEBUG && targetEnvironment(simulator)
import SwiftUI

/// UI tests only (`CONN_TEST_KEYBOARD_PROBE`): the keyboard's show and hide notifications, in
/// order, as a 1 pt element (`debug.keyboard`), so a test sees a down-up it would miss by polling.
@MainActor @Observable
final class KeyboardProbe {
    static let shared = KeyboardProbe()
    static let enabled = ProcessInfo.processInfo.environment["CONN_TEST_KEYBOARD_PROBE"] != nil

    private(set) var events: [String] = []
    @ObservationIgnored private var observers: [NSObjectProtocol] = []

    private init() {
        guard Self.enabled else { return }
        let center = NotificationCenter.default
        for (name, label) in [
            (UIResponder.keyboardWillShowNotification, "show"),
            (UIResponder.keyboardWillHideNotification, "hide"),
        ] {
            observers.append(center.addObserver(forName: name, object: nil, queue: .main) { _ in
                MainActor.assumeIsolated { KeyboardProbe.shared.events.append(label) }
            })
        }
    }
}

struct KeyboardProbeView: View {
    private let probe = KeyboardProbe.shared

    var body: some View {
        if KeyboardProbe.enabled {
            Text(probe.events.isEmpty ? "none" : probe.events.joined(separator: ","))
                .font(.system(size: 1))
                .frame(width: 1, height: 1)
                .opacity(0.02)
                .allowsHitTesting(false)
                .accessibilityIdentifier("debug.keyboard")
        }
    }
}
#endif
