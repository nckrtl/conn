import SwiftUI

// MARK: - PendingApprovalCard (1:1 port of PendingApprovalCard.tsx)

/// The approval the agent waits for, above the composer: what it asks and the answers.
/// Its content comes from Rust (`conn-ffi` `approvals`); this view only draws it.
struct PendingApprovalCard: View {
    let approval: FfiPendingApproval
    let remaining: Int
    /// An answer for this approval is on its way.
    let responding: Bool
    let onRespond: (FfiApprovalDecision) -> Void

    @Environment(\.connTheme) private var theme
    @Environment(\.colorScheme) private var appearance
    @State private var explanationOpen = false

    var body: some View {
        VStack(alignment: .leading, spacing: 3) {
            // Lab `.m-composer-panel-header`: 8 gap, `10 17` padding, 500 13/16, a 14 pt shield.
            HStack(spacing: 8) {
                ThreadGlyph(name: "needs-approval", size: 14)
                Text("Approval needed")
                Spacer()
                if approval.title.caseInsensitiveCompare("Command") == .orderedSame {
                    ThreadGlyph(name: "terminal", size: 16).accessibilityLabel(approval.title)
                } else { Text(approval.title) }
                if remaining > 1 { Text("\(remaining) pending") }
            }
            .font(.system(size: 13, weight: .medium)).lineHeight(.exact(points: 16))
            .foregroundStyle(theme.mutedForeground)
            .padding(.horizontal, 17).padding(.vertical, 10)
            .frame(minHeight: 30)
            VStack(alignment: .leading, spacing: 8) {
                if let detail = approval.detail {
                    // Lab `.m-code-body.m-composer-approval-detail`: 13 pt mono, `13 21` padding.
                    HighlightedSource(code: detail, language: approval.title.lowercased() == "command" ? "sh" : "", baseSize: 13)
                }
                if let reason = approval.reason {
                    Text(reason)
                        .font(.system(size: 13))
                        .lineSpacing(3)
                        .foregroundStyle(theme.warning)
                }
                if let explanation = approval.fullAccessExplanation {
                    Button {
                        explanationOpen.toggle()
                    } label: {
                        VStack(alignment: .leading, spacing: 4) {
                            Text("Why am I being asked this?")
                                .font(.system(size: 13, weight: .bold))
                                .underline()
                                .foregroundStyle(theme.mutedForeground)
                            if explanationOpen {
                                Text(explanation)
                                    .font(.system(size: 13))
                                    .lineSpacing(3)
                                    .foregroundStyle(theme.mutedForeground)
                                    .multilineTextAlignment(.leading)
                            }
                        }
                    }
                    .buttonStyle(.plain)
                    .accessibilityValue(explanationOpen ? "Expanded" : "Collapsed")
                }
                if !approval.answerable {
                    Text(
                        "The provider process for this request is no longer available. Interrupt or restart the run to continue."
                    )
                    .font(.system(size: 14))
                    .foregroundStyle(theme.mutedForeground)
                    .accessibilityIdentifier("approval.notAnswerable")
                }
                if let warning = approval.warning {
                    Text(warning)
                        .font(.system(size: 13))
                        .lineSpacing(3)
                        .foregroundStyle(theme.warning)
                }
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(.horizontal, 21).padding(.vertical, 13)
            .background(theme.codeBackground, in: .rect(cornerRadius: 25))
            .composerPanelEdge(radius: 25)

            ViewThatFits(in: .horizontal) {
                HStack(spacing: 8) { actions }
                VStack(alignment: .trailing, spacing: 8) { actions }
            }
            .frame(maxWidth: .infinity, alignment: .trailing)
            .padding(.horizontal, 8).padding(.vertical, 10)
        }
        .padding(3)
        .background(threadCardSurface(theme, appearance), in: .rect(cornerRadius: 28))
        .composerPanelEdge(radius: 28)
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("thread.approval.\(approval.requestId)")
    }
    private var actions: some View {
        ForEach(approval.options, id: \.decision) { option in
            if option.decision == .cancel {
                // Lab `.m-composer-text-action`: 500 14/19, 21 pt in from the panel's edge.
                Button(option.label) { onRespond(.cancel) }.font(.system(size: 14, weight: .medium))
                    .lineHeight(.exact(points: 19))
                    .padding(.leading, 13).frame(minHeight: 40)
                    .foregroundStyle(theme.mutedForeground).disabled(!approval.answerable || responding)
                    .accessibilityIdentifier("approval.option." + option.label)
                Spacer(minLength: 0)
            } else {
            ConnButton(label: option.label, tone: option.tone, size: .compact, disabled: !approval.answerable || responding) {
                onRespond(option.decision)
            }.accessibilityIdentifier("approval.option.\(option.label)")
            }
        }
    }

}

// MARK: - ConnButton (port of mobile's ui/Button)

/// A capsule button in one of mobile's tones: full width and 48pt high, or compact (40pt,
/// sized to its label).
struct ConnButton: View {
    enum Size { case regular, compact }

    let label: String
    let tone: FfiButtonTone
    var size: Size = .regular
    /// Overrides the label inset: compact is 12 (approval), the question pills use 20.
    var horizontalPadding: CGFloat?
    /// The fill while disabled; the tone's own fill by default.
    var disabledFill: Color?
    var disabled = false
    var loading = false
    let action: () -> Void

    @Environment(\.connTheme) private var theme

    var body: some View {
        Button(action: action) {
            ZStack {
                Text(label)
                    .font(.system(size: 16, weight: .medium))
                    .lineHeight(.exact(points: 23))
                    .foregroundStyle(disabled ? theme.mutedForeground : labelColor)
                    .lineLimit(1)
                    .opacity(loading ? 0 : 1)
                if loading {
                    ProgressView().tint(labelColor)
                }
            }
            // `min-h-12 px-6` / compact `min-h-10 px-5`, at 3.5pt per unit.
            .padding(.horizontal, horizontalPadding ?? (size == .compact ? 12 : 21))
            .frame(maxWidth: size == .compact ? nil : .infinity, minHeight: size == .compact ? 40 : 48)
            .background(Capsule().fill(disabled ? (disabledFill ?? fill) : fill))
            .contentShape(Capsule())
        }
        .buttonStyle(PressedOpacityStyle())
        .disabled(disabled || loading)
    }

    private var fill: Color {
        switch tone {
        case .primary: theme.primary
        case .secondary: theme.secondary
        case .danger: theme.destructive.opacity(0.12)
        }
    }

    private var labelColor: Color {
        switch tone {
        case .primary: theme.primaryForeground
        case .secondary: theme.secondaryForeground
        case .danger: theme.destructive
        }
    }
}

/// `active:opacity-70`.
struct PressedOpacityStyle: ButtonStyle {
    func makeBody(configuration: Configuration) -> some View {
        configuration.label.opacity(configuration.isPressed ? 0.7 : 1)
    }
}

// MARK: - HeightCappedScroll

/// Its content's own height up to `maxHeight`, scrolling past that. `onEdges` hears whether
/// content is scrolled out of view at the top and at the bottom.
struct HeightCappedScroll<Content: View>: View {
    let maxHeight: CGFloat
    let content: Content
    let onEdges: ((Bool, Bool) -> Void)?
    @State private var contentHeight: CGFloat = 0

    init(
        maxHeight: CGFloat,
        @ViewBuilder content: () -> Content,
        onEdges: ((Bool, Bool) -> Void)? = nil
    ) {
        self.maxHeight = maxHeight
        self.content = content()
        self.onEdges = onEdges
    }

    var body: some View {
        ScrollView {
            content.onGeometryChange(for: CGFloat.self) { $0.size.height } action: { contentHeight = $0 }
        }
        .scrollBounceBehavior(.basedOnSize)
        .frame(height: min(max(contentHeight, 1), maxHeight))
        .onScrollGeometryChange(for: [Bool].self) { geo in
            let offset = geo.contentOffset.y + geo.contentInsets.top
            return [offset > 1, offset + geo.containerSize.height < geo.contentSize.height - 1]
        } action: { _, edges in
            onEdges?(edges[0], edges[1])
        }
    }
}
