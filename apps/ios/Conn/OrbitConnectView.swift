import SwiftUI

/// Lab `LaunchScreen` and `ConnectionAlert`.
struct OrbitConnectView: View {
    let store: CoreStore
    let state: OrbitConnectState
    @Environment(\.connTheme) private var theme

    var body: some View {
        ZStack {
            theme.background.ignoresSafeArea()
            Image("LaunchMark")
                .resizable()
                .renderingMode(.template)
                .scaledToFit()
                .foregroundStyle(theme.foreground)
                .frame(width: 96, height: 64)
                .frame(maxWidth: .infinity, maxHeight: .infinity).ignoresSafeArea()
                .accessibilityHidden(true)
            switch state {
            case let .connecting(message):
                // 15/20 medium, muted, 16 in from the sides and 36 above the screen's bottom edge.
                Text(message)
                    .font(.system(size: 15, weight: .medium))
                    .frame(minHeight: 20)
                    .multilineTextAlignment(.center)
                    .foregroundStyle(theme.mutedForeground)
                    .padding(.horizontal, 16)
                    .padding(.bottom, 36)
                    .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .bottom)
                    .ignoresSafeArea()
                    .accessibilityIdentifier("orbit.connecting")
            case let .failed(message, detail):
                Color.black.opacity(0.36).ignoresSafeArea()
                VStack(spacing: 0) {
                    Text(message)
                        .font(.system(size: 17, weight: .semibold))
                        .padding(.horizontal, 20).padding(.top, 20).padding(.bottom, 6)
                        .accessibilityIdentifier("orbit.errorText")
                    if let detail, !detail.isEmpty {
                        Text(detail).font(.system(size: 14)).lineSpacing(2)
                            .padding(.horizontal, 20)
                    }
                    Rectangle().fill(theme.border).frame(height: 1).padding(.top, 20)
                    HStack(spacing: 0) {
                        Button("Connect manually") { store.showManualPairing() }
                            .font(.system(size: 16, weight: .medium))
                            .frame(maxWidth: .infinity, maxHeight: .infinity)
                            .accessibilityIdentifier("orbit.manualButton")
                        Rectangle().fill(theme.border).frame(width: 1)
                        Button("Try again") { store.retry() }
                            .font(.system(size: 16, weight: .semibold))
                            .frame(maxWidth: .infinity, maxHeight: .infinity)
                            .accessibilityIdentifier("orbit.retryButton")
                    }
                    .buttonStyle(.plain)
                    .foregroundStyle(theme.accentForeground)
                    .frame(height: 46)
                }
                .foregroundStyle(theme.foreground)
                .multilineTextAlignment(.center)
                .frame(width: 280)
                .background(Color(ffi: theme.tokens.popover), in: RoundedRectangle(cornerRadius: 20))
                .overlay(RoundedRectangle(cornerRadius: 20).strokeBorder(theme.border, lineWidth: 1))
                .clipShape(RoundedRectangle(cornerRadius: 20))
                .shadow(color: .black.opacity(0.16), radius: 18, y: 10)
            }
        }
    }
}
