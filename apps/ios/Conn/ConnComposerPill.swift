import DesignKit
import SwiftUI

struct ConnComposerPill<Trailing: View>: View {
    let placeholder: String
    @Binding var text: String
    var maxLines = 4
    var isBusy = false
    var canSend = false
    let onSend: () -> Void
    var onStop: (() -> Void)?
    @ViewBuilder let trailing: () -> Trailing

    @Environment(\.connTheme) private var theme

    private static var radius: CGFloat { 27 }
    private static var control: CGFloat { 44 }

    var body: some View {
        let shape = RoundedRectangle(cornerRadius: Self.radius, style: .continuous)
        // Mobile's `+` (`ComposerAttachmentButton`) stays out until the core sends attachments.
        HStack(alignment: .bottom, spacing: 0) {
            TextField(
                placeholder, text: $text,
                prompt: Text(placeholder).foregroundStyle(Color(ffi: theme.tokens.placeholder)),
                axis: .vertical
            )
                .textFieldStyle(.plain)
                .font(.system(size: 16))
                .lineHeight(.exact(points: 24))
                .tint(theme.foreground)
                .foregroundStyle(theme.foreground)
                .lineLimit(1...maxLines)
                .padding(.vertical, 10)
                .padding(.leading, 12)
                .frame(maxWidth: .infinity, minHeight: Self.control, alignment: .leading)

            trailing()
                .frame(minHeight: Self.control)

            actionButton
        }
        .padding(.horizontal, 4)
        .padding(.vertical, 2)
        .modifier(ThreadControlSurface(shape: shape))
    }

    /// Mobile's send button: a 30pt primary circle with `arrow.up` 16 semibold in a 44pt target.
    private var actionButton: some View {
        Button {
            if isBusy { onStop?() } else if canSend { onSend() }
        } label: {
            ZStack {
                Circle()
                    .fill(fill)
                    .frame(width: 30, height: 30)
                if isBusy {
                    ThreadGlyph(name: "stop", size: 12)
                        .foregroundStyle(theme.primaryForeground)
                } else {
                    ThreadGlyph(name: "arrow-up", size: 16)
                        .foregroundStyle(canSend ? theme.primaryForeground : theme.mutedForeground)
                }
            }
            .opacity(canSend || isBusy ? 1 : 0.55)
            .frame(width: Self.control, height: Self.control)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .disabled(isBusy ? onStop == nil : !canSend)
        .accessibilityLabel(isBusy ? "Stop" : "Send")
    }

    private var fill: Color {
        if isBusy || canSend { return theme.primary }
        return theme.foreground.opacity(0.06)
    }
}

/// `ComposerModelControl` collapsed (`iconOnly`): the provider icon at 16 and a 10pt chevron in a
/// 44pt target. It opens the thread settings sheet.
struct ConnComposerModelChip: View {
    let driver: String?
    let modelLabel: String?
    let action: () -> Void
    @Environment(\.connTheme) private var theme

    var body: some View {
        Button(action: action) {
            HStack(spacing: 3.5) {
                ProviderIcon(driver: driver, size: 16)
                ThreadGlyph(name: "chevron-down", size: 10)
                    .foregroundStyle(theme.foreground)
            }
            .padding(.horizontal, 7)
            .frame(minHeight: 44)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .accessibilityLabel(modelLabel.map { "Model, \($0)" } ?? "Model")
        .accessibilityIdentifier("composer.modelButton")
    }
}

struct ProviderIcon: View {
    let driver: String?
    var size: CGFloat = 16
    @Environment(\.connTheme) private var theme
    @Environment(\.colorScheme) private var colorScheme

    var body: some View {
        switch driver?.trimmingCharacters(in: .whitespaces).lowercased() {
        case "claude", "claudeagent":
            Image("provider-claude").resizable().scaledToFit().frame(width: size, height: size)
        case "antigravity":
            Image("provider-antigravity").resizable().scaledToFit().frame(width: size, height: size)
        case "grok":
            // `@t3tools/provider-grok/client`'s icon: #F5F5F5 (dark) or #0F0F0F (light).
            Image("provider-grok")
                .resizable()
                .renderingMode(.template)
                .scaledToFit()
                .frame(width: size, height: size)
                .foregroundStyle(colorScheme == .dark ? Color(white: 0.96) : Color(white: 0.059))
        default:
            Image("provider-default")
                .resizable()
                .renderingMode(.template)
                .scaledToFit()
                .frame(width: size, height: size)
                .foregroundStyle(theme.mutedForeground)
        }
    }
}

struct ThreadControlSurface<S: InsettableShape>: ViewModifier {
    let shape: S
    @Environment(\.connTheme) private var theme

    func body(content: Content) -> some View {
        content
            .background {
                shape.fill(theme.footerSurface)
                    .background(.ultraThinMaterial, in: shape)
                    .shadow(color: .black.opacity(0.12), radius: 8, y: 3)
            }
            .overlay { shape.strokeBorder(theme.border, lineWidth: 0.5).allowsHitTesting(false) }
    }
}
