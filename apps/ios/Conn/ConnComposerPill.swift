import DesignKit
import SwiftUI
import UniformTypeIdentifiers

struct ConnComposerPill<Trailing: View>: View {
    let placeholder: String
    @Bindable var draft: ComposerDraft
    let limits: FfiComposerLimits
    var allowsAttachments = true
    var maxLines = 4
    var isBusy = false
    var canSend = false
    let onSend: () -> Void
    var onStop: (() -> Void)?
    @ViewBuilder let trailing: () -> Trailing

    @Environment(\.connTheme) private var theme

    @State private var showingPhotos = false
    @State private var showingFiles = false

    private static var radius: CGFloat { 27 }
    private static var control: CGFloat { 44 }

    var body: some View {
        let shape = RoundedRectangle(cornerRadius: Self.radius, style: .continuous)
        VStack(alignment: .leading, spacing: 0) {
            if allowsAttachments && !draft.files.isEmpty {
                // Lab `.m-draft-files`: above the pill, `gap 6`, `padding 0 4`, `margin 0 0 6`.
                ScrollView(.horizontal) {
                    HStack(spacing: 6) {
                        ForEach(draft.files) { file in
                            HStack(spacing: 6) {
                                ThreadGlyph(name: "file-text", size: 16)
                                Text(file.name).lineLimit(1).truncationMode(.middle)
                                Button {
                                    draft.files.removeAll { $0.id == file.id }
                                } label: {
                                    ThreadGlyph(name: "close", size: 14)
                                        .frame(minWidth: 44, minHeight: 44)
                                        .contentShape(Rectangle())
                                }
                                .buttonStyle(.plain)
                                .disabled(draft.locked)
                                .accessibilityLabel("Remove \(file.name)")
                            }
                            .font(.system(size: 13))
                            .padding(.leading, 10)
                            .background(theme.card.opacity(0.78), in: RoundedRectangle(cornerRadius: 12, style: .continuous))
                        }
                    }
                    .padding(.horizontal, 4)
                }
                .scrollIndicators(.hidden)
                .padding(.bottom, 6)
            }
            VStack(alignment: .leading, spacing: 0) {
                if let error = draft.error {
                    Text(error)
                        .font(.footnote)
                        .foregroundStyle(theme.destructive)
                        .padding(.horizontal, 14)
                        .padding(.top, 8)
                        .accessibilityLabel("Attachment or send error, \(error)")
                }
                HStack(alignment: .bottom, spacing: 0) {
                    if allowsAttachments && limits.images {
                        Menu {
                            Button("Photos", systemImage: "photo.on.rectangle") { showingPhotos = true }
                            if limits.maxFileBytes != nil {
                                Button("Files", systemImage: "folder") { showingFiles = true }
                            }
                        } label: {
                            ThreadGlyph(name: "add", size: 20)
                                .frame(width: Self.control, height: Self.control)
                                .contentShape(Rectangle())
                        }
                        .disabled(draft.locked || draft.files.count >= 100)
                        .accessibilityLabel("Add attachment")
                    }
                    TextField(
                        placeholder, text: $draft.text,
                        prompt: Text(placeholder).foregroundStyle(theme.placeholder),
                        axis: .vertical
                    )
                        .textFieldStyle(.plain)
                        .font(.system(size: 16))
                        .lineHeight(.exact(points: 24))
                        .tint(theme.foreground)
                        .lineLimit(1...maxLines)
                        .padding(.vertical, 10)
                        .padding(.leading, 12)
                        .frame(maxWidth: .infinity, minHeight: Self.control, alignment: .leading)
                        .disabled(draft.sending)

                    trailing().frame(minHeight: Self.control)
                    if draft.locked {
                        ProgressView()
                            .frame(width: Self.control, height: Self.control)
                            .accessibilityLabel(draft.sending ? "Sending" : "Adding attachment")
                    } else {
                        actionButton
                    }
                }
            }
            .padding(.horizontal, 4)
            .padding(.vertical, 2)
            .foregroundStyle(theme.foreground)
            .glassEffect(.regular, in: shape)
            .background(theme.background, in: shape)
        }
        .sheet(isPresented: $showingPhotos) {
            ComposerPhotosPicker(draft: draft, limits: limits) { showingPhotos = false }
        }
        .fileImporter(isPresented: $showingFiles, allowedContentTypes: [.item], allowsMultipleSelection: true) { result in
            importFiles(result)
        }
    }

    private func importFiles(_ result: Result<[URL], Error>) {
        switch result {
        case let .success(urls):
            guard !urls.isEmpty, !draft.locked else { return }
            draft.importing = true
            draft.error = nil
            Task {
                defer { draft.importing = false }
                do {
                    for url in urls {
                        try draft.append(await ComposerFile.document(url, limits: limits))
                    }
                } catch { draft.error = error.localizedDescription }
            }
        case let .failure(error):
            if (error as NSError).code != NSUserCancelledError { draft.error = error.localizedDescription }
        }
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
