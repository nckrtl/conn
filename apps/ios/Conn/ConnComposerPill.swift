import DesignKit
import SwiftUI

/// Conn mobile's floating composer pill (`ComposerSurface.tsx`, `ThreadComposer.tsx`): regular
/// Liquid Glass, radius 27, a 44pt control row inside 4×2 padding (48pt tall when collapsed), and
/// a `0 6 28` shadow at 15% black (light) / 35% (dark). It floats over the feed; no band behind it.
struct ConnComposerPill<Leading: View, Trailing: View>: View {
    let placeholder: String
    @Binding var text: String
    var maxLines = 4
    var isBusy = false
    var canSend = false
    let onSend: () -> Void
    var onStop: (() -> Void)?
    @ViewBuilder let leading: () -> Leading
    @ViewBuilder let trailing: () -> Trailing

    @Environment(\.connTheme) private var theme
    @Environment(\.colorScheme) private var colorScheme

    /// `rounded-[27px]`, `paddingVertical: 2`, `px-1`, and the 44pt control row.
    private static var radius: CGFloat { 27 }
    private static var control: CGFloat { 44 }

    var body: some View {
        let shape = RoundedRectangle(cornerRadius: Self.radius, style: .continuous)
        HStack(alignment: .bottom, spacing: 0) {
            leading()
                .frame(width: Self.control, height: Self.control)

            // Body text 16/23 (`useComposerTextStyle(body)`), at least 36 tall, up to four lines.
            TextField(placeholder, text: $text, axis: .vertical)
                .textFieldStyle(.plain)
                .font(.system(size: 16))
                .lineSpacing(4)
                .foregroundStyle(theme.foreground)
                .lineLimit(1...maxLines)
                .padding(.vertical, 10)
                .frame(maxWidth: .infinity, minHeight: Self.control, alignment: .leading)

            trailing()
                .frame(minHeight: Self.control)

            actionButton
        }
        .padding(.horizontal, 4)
        .padding(.vertical, 2)
        .glassEffect(.regular.interactive(), in: shape)
        .shadow(color: .black.opacity(colorScheme == .dark ? 0.35 : 0.15), radius: 14, y: 6)
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
                    KitIconImage(.stop, size: 12)
                        .foregroundStyle(theme.primaryForeground)
                } else {
                    ConnIcon("arrow.up")
                        .font(.system(size: 16, weight: .semibold))
                        .foregroundStyle(canSend ? theme.primaryForeground : theme.mutedForeground)
                }
            }
            .frame(width: Self.control, height: Self.control)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .disabled(isBusy ? onStop == nil : !canSend)
        .accessibilityLabel(isBusy ? "Stop" : "Send")
    }

    private var fill: Color {
        if isBusy || canSend { return theme.primary }
        return theme.foreground.opacity(0.08)
    }
}

/// `ComposerAttachmentButton`: a 20pt `plus` in a 44pt target. Attachments are not built yet.
struct ConnComposerAttachButton: View {
    @Environment(\.connTheme) private var theme

    var body: some View {
        Menu {
            Button("Attachments (coming soon)") {}
                .disabled(true)
        } label: {
            ConnIcon("plus")
                .font(.system(size: 20))
                .foregroundStyle(theme.foreground)
                .frame(width: 44, height: 44)
                .contentShape(Rectangle())
        }
        .accessibilityLabel("More composer actions")
    }
}

/// The collapsed model chip: the provider icon at 16 and a 10pt chevron, 44pt tall.
struct ConnComposerModelChip: View {
    @Environment(\.connTheme) private var theme

    var body: some View {
        HStack(spacing: 3.5) {
            Image(systemName: "sparkle")
                .font(.system(size: 16, weight: .semibold))
                .foregroundStyle(Color(red: 0.85, green: 0.47, blue: 0.34))
            Image(systemName: "chevron.down")
                .font(.system(size: 10, weight: .semibold))
                .foregroundStyle(theme.mutedForeground)
        }
        .padding(.horizontal, 7)
        .frame(minHeight: 44)
    }
}
