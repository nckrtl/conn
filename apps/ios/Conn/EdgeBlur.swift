import SwiftUI
import UIKit

/// Conn mobile's `EdgeBlur` (UIKit's soft scroll-edge effect), drawn by hand because the thread's
/// composer is not a `safeAreaBar`: strongest at the screen edge, tapering to nothing.
/// Sits above the feed and below the floating controls, ignoring the safe area at its edge;
/// static, so scrolling never redraws it.
struct EdgeBlur: View {
    enum Edge { case top, bottom }

    let edge: Edge
    /// The band at full strength past the safe area at this edge (header bar or home indicator).
    var solid: CGFloat = 0
    /// The band past `solid` over which the blur tapers to nothing.
    var taper: CGFloat = 28

    @Environment(\.connTheme) private var theme
    @State private var safeInset: CGFloat = 0

    var body: some View {
        let full = safeInset + max(0, solid)
        let total = full + taper
        let solidEnd = full / total
        ZStack {
            ProgressiveBlur(edge: edge, solidEnd: solidEnd)
            LinearGradient(
                stops: [
                    .init(color: theme.background.opacity(0.7), location: 0),
                    .init(color: theme.background.opacity(0.35), location: solidEnd * 0.6),
                    .init(color: theme.background.opacity(0), location: 1),
                ],
                startPoint: edge == .top ? .top : .bottom,
                endPoint: edge == .top ? .bottom : .top
            )
        }
        .frame(height: total)
        .onGeometryChange(for: CGFloat.self) {
            edge == .top ? $0.safeAreaInsets.top : $0.safeAreaInsets.bottom
        } action: { safeInset = $0 }
        .allowsHitTesting(false)
        .accessibilityHidden(true)
    }
}

/// A system blur masked by a gradient: opaque at the edge, still strong at the end of the solid
/// band, clear at the far end.
private struct ProgressiveBlur: UIViewRepresentable {
    let edge: EdgeBlur.Edge
    let solidEnd: CGFloat

    func makeUIView(context: Context) -> ProgressiveBlurView {
        ProgressiveBlurView()
    }

    func updateUIView(_ view: ProgressiveBlurView, context: Context) {
        view.configure(edge: edge, solidEnd: solidEnd)
    }
}

final class ProgressiveBlurView: UIVisualEffectView {
    private let gradient = CAGradientLayer()
    private let maskContainer = UIView()

    init() {
        // `.regular` follows the light or dark trait SwiftUI passes down.
        super.init(effect: UIBlurEffect(style: .regular))
        isUserInteractionEnabled = false
        maskContainer.layer.addSublayer(gradient)
        mask = maskContainer
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) { fatalError("init(coder:) is not supported") }

    fileprivate func configure(edge: EdgeBlur.Edge, solidEnd: CGFloat) {
        let solid = Double(min(max(solidEnd, 0), 1))
        CATransaction.begin()
        CATransaction.setDisableActions(true)
        gradient.colors = [1.0, 0.85, 0.4, 0.0].map { UIColor.black.withAlphaComponent($0).cgColor }
        gradient.locations = [0, solid, solid + (1 - solid) * 0.5, 1].map { NSNumber(value: $0) }
        gradient.startPoint = CGPoint(x: 0.5, y: edge == .top ? 0 : 1)
        gradient.endPoint = CGPoint(x: 0.5, y: edge == .top ? 1 : 0)
        CATransaction.commit()
    }

    override func layoutSubviews() {
        super.layoutSubviews()
        CATransaction.begin()
        CATransaction.setDisableActions(true)
        maskContainer.frame = bounds
        gradient.frame = bounds
        CATransaction.commit()
    }
}
