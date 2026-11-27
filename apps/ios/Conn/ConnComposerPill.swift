import DesignKit
import SwiftUI
import ImageIO
import UIKit
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
    @Environment(\.composerResize) private var composerResize

    @State private var showingPhotos = false
    @State private var showingFiles = false
    @State private var dictation = DictationController()
    @State private var sendAfterDictation = false
    @State private var selection: TextSelection?
    @State private var keyboardUp = false
    /// The row's width and the trailing controls' width, for the text's room in one row.
    @State private var rowWidth: CGFloat = 0
    @State private var trailingWidth: CGFloat = 0
    @FocusState private var inputFocused: Bool

    private static var control: CGFloat { 44 }
    /// The standard spring without bounce, for the collapsed/expanded switch and the keyboard gap.
    private static var spring: Animation { .spring(duration: 0.4, bounce: 0) }

    /// Lab `data-expanded`: the text would reach the controls, so it takes its own line above
    /// them. Focus alone never changes the layout: the box keeps its height as the keyboard opens.
    private var expanded: Bool {
        let leading: CGFloat = hasLeadingControl ? Self.control : 0
        let room = rowWidth - leading - trailingWidth
            - ComposerInputMetrics.leadingInset(expanded: false, hasLeadingControl: hasLeadingControl)
        return ComposerInputMetrics.wraps(draft.text.isEmpty ? fieldPlaceholder : draft.text, in: room)
    }

    var body: some View {
        let _ = BodyCount.tick("Composer")
        // Keyboard up: a sheet with 28 pt top corners and none below. Down: the floating pill.
        let corner: CGFloat = expanded ? 24 : 27
        let top = keyboardUp ? ComposerSheet.topRadius : corner
        let bottom = keyboardUp ? 0 : corner
        let shape = UnevenRoundedRectangle(
            topLeadingRadius: top, bottomLeadingRadius: bottom,
            bottomTrailingRadius: bottom, topTrailingRadius: top, style: .continuous
        )
        VStack(alignment: .leading, spacing: 0) {
            if allowsAttachments && !draft.files.isEmpty {
                // Lab `.m-draft-files`: images are 60 pt thumbnails (Conn mobile's composer strip),
                // files keep their chip. 7 pt above and 11 pt to the right hold the remove targets.
                ScrollView(.horizontal) {
                    HStack(spacing: 10) {
                        ForEach(draft.files) { file in
                            if file.isImage {
                                ComposerImageThumbnail(file: file, locked: draft.locked) {
                                    draft.files.removeAll { $0.id == file.id }
                                }
                            } else {
                                ComposerFileChip(file: file, locked: draft.locked) {
                                    draft.files.removeAll { $0.id == file.id }
                                }
                            }
                        }
                    }
                    .padding(.leading, 4)
                    .padding(.trailing, 11)
                    .padding(.top, 7)
                }
                .scrollIndicators(.hidden)
                .padding(.bottom, 6)
            }
            VStack(alignment: .leading, spacing: 0) {
                // Desktop: the edit header is the composer card's top row.
                ComposerQueuedEditBar(draft: draft)
                if let error = draft.error {
                    Text(error)
                        .font(.footnote)
                        .foregroundStyle(theme.destructive)
                        .padding(.horizontal, 14)
                        .padding(.top, 8)
                        .accessibilityLabel("Attachment or send error, \(error)")
                } else if let error = dictation.error {
                    Text(error)
                        .font(.footnote)
                        .foregroundStyle(theme.destructive)
                        .padding(.horizontal, 14)
                        .padding(.top, 8)
                        .accessibilityLabel("Dictation error, \(error)")
                }
                // One layout, one TextField: switching `expanded` or dictating only swaps the
                // controls around the same field, so focus and the keyboard survive.
                ComposerRowLayout(expanded: expanded) {
                    if dictation.isActive {
                        if dictation.phase != .transcribing {
                            Button { sendAfterDictation = false; dictation.cancel() } label: {
                                ThreadGlyph(name: "close", size: 20)
                                    .frame(width: Self.control, height: Self.control)
                                    .contentShape(Rectangle())
                            }
                            .buttonStyle(.plain)
                            .accessibilityLabel("Cancel dictation")
                            .composerSlot(.leading)
                        }
                    } else if allowsAttachments && limits.images {
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
                        .composerSlot(.leading)
                    }
                    // A hidden copy of the text sizes the field. The text field reports the height
                    // of its last UIKit layout, so after a width change (one row to two) it stayed
                    // a line too tall until the next keystroke.
                    Text(sizingText)
                        .font(.system(size: ComposerInputMetrics.fontSize))
                        .lineSpacing(ComposerInputMetrics.lineSpacing)
                        .lineLimit(1...maxLines)
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .hidden()
                        .accessibilityHidden(true)
                        .overlay(alignment: .topLeading) {
                            TextField(
                                fieldPlaceholder, text: $draft.text, selection: $selection,
                                prompt: Text(fieldPlaceholder).foregroundStyle(theme.placeholder),
                                axis: .vertical
                            )
                            .textFieldStyle(.plain)
                            .font(.system(size: ComposerInputMetrics.fontSize))
                            .lineSpacing(ComposerInputMetrics.lineSpacing)
                            .tint(theme.foreground)
                            .lineLimit(1...maxLines)
                            .frame(maxHeight: .infinity, alignment: .topLeading)
                            .focused($inputFocused)
                        }
                        .padding(.top, ComposerInputMetrics.topInset(expanded: expanded))
                        .padding(.bottom, ComposerInputMetrics.bottomInset(expanded: expanded))
                        .padding(.leading, ComposerInputMetrics.leadingInset(
                            expanded: expanded, hasLeadingControl: hasLeadingControl
                        ))
                        .padding(.trailing, expanded ? ComposerInputMetrics.expandedTrailingInset : 0)
                        .composerSlot(.field)

                    Group {
                        if dictation.isActive {
                            dictationControls
                        } else {
                            HStack(spacing: 0) {
                                trailing().frame(minHeight: Self.control)
                                // Conn mobile keeps the mic beside stop while the agent works, so a follow-up
                                // can be dictated and queued; it is only disabled while the draft is locked.
                                micButton.disabled(draft.locked).opacity(draft.locked ? 0.4 : 1)
                                if draft.locked {
                                    ProgressView()
                                        .frame(width: Self.control, height: Self.control)
                                        .accessibilityLabel(draft.sending ? "Sending" : "Adding attachment")
                                } else {
                                    actionButton
                                }
                            }
                        }
                    }
                    .onGeometryChange(for: CGFloat.self) { $0.size.width } action: { trailingWidth = $0 }
                    .composerSlot(.trailing)
                }
                .onGeometryChange(for: CGFloat.self) { $0.size.width } action: { rowWidth = $0 }
            }
            // Keyboard up the sheet is wider than the pill, so the controls move out with it.
            .padding(.horizontal, keyboardUp ? ComposerSheet.controlsInset : 4)
            .padding(.vertical, 2)
            .foregroundStyle(theme.foreground)
            // The pill and the sheet are one Liquid Glass surface in two shapes, applied to the
            // content itself so the text and controls draw above the glass (as a separate background
            // inside the screen's GlassEffectContainer, the glass drew over them). Keyboard up the
            // frame grows to the screen edges and `bottomBleed` below the box, behind the keyboard,
            // before the glass; the negative padding after it keeps the layout where it was.
            .padding(.horizontal, keyboardUp ? ComposerSheet.screenInset : 0)
            .padding(.bottom, keyboardUp ? ComposerSheet.bottomBleed : 0)
            .glassEffect(.regular, in: shape)
            .overlay(alignment: .top) { ComposerSheetEdge(shape: shape, color: theme.border, visible: keyboardUp) }
            // Desktop: the composer card's border turns primary at 45% while a queued message is open.
            .overlay { if draft.queuedEdit != nil { shape.strokeBorder(theme.primary.opacity(0.45), lineWidth: 1) } }
            .padding(.horizontal, keyboardUp ? -ComposerSheet.screenInset : 0)
            .padding(.bottom, keyboardUp ? -ComposerSheet.bottomBleed : 0)
        }
        .animation(Self.spring, value: expanded)
        // A UIKit host resizes on the same spring, so the box grows from its bottom edge.
        .onChange(of: expanded) { composerResize(Self.spring) }
        .onReceive(NotificationCenter.default.publisher(for: UIResponder.keyboardWillChangeFrameNotification)) { note in
            setKeyboardUp(KeyboardOverlap.isUp(note), note)
        }
        .onReceive(NotificationCenter.default.publisher(for: UIResponder.keyboardWillHideNotification)) { note in
            setKeyboardUp(false, note)
        }
        .onChange(of: draft.text) { dictation.error = nil }
        .onChange(of: draft.focusRequest) {
            selection = TextSelection(insertionPoint: draft.text.endIndex)
            inputFocused = true
        }
        .sheet(isPresented: $showingPhotos) {
            ComposerPhotosPicker(draft: draft, limits: limits) { showingPhotos = false }
        }
        .fileImporter(isPresented: $showingFiles, allowedContentTypes: [.item], allowsMultipleSelection: true) { result in
            importFiles(result)
        }
    }

    /// The morph runs on the keyboard's own duration and curve, so it moves with the keyboard.
    private func setKeyboardUp(_ up: Bool, _ note: Notification) {
        guard up != keyboardUp else { return }
        withAnimation(KeyboardMotion.animation(note)) { keyboardUp = up }
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

    /// Lab `.m-composer-mic`: an 18pt `microphone`, muted, in a 36 x 44 target.
    private var micButton: some View {
        Button(action: startDictation) {
            ThreadGlyph(name: "microphone", size: 18)
                .foregroundStyle(theme.mutedForeground)
                .frame(width: 36, height: Self.control)
                .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .accessibilityLabel("Dictate")
        .accessibilityIdentifier("composer.dictateButton")
    }

    private var hasLeadingControl: Bool {
        dictation.isActive ? dictation.phase != .transcribing : allowsAttachments && limits.images
    }

    /// The field's text for sizing: the placeholder when empty, and a trailing line break keeps
    /// its empty last line.
    private var sizingText: String {
        if draft.text.isEmpty { return fieldPlaceholder }
        return draft.text.last?.isNewline == true ? draft.text + " " : draft.text
    }

    private var fieldPlaceholder: String {
        switch dictation.phase {
        case .recording: "Listening…"
        case .transcribing: "Transcribing…"
        case .idle: placeholder
        case .starting: "Preparing…"
        }
    }

    /// While dictating: the elapsed time, a bare stop where the mic sits, and the send circle.
    /// Stop puts the transcript in the field; send puts it in and sends it as soon as it's ready.
    /// The text field stays, so the keyboard does too.
    private var dictationControls: some View {
        HStack(spacing: 0) {
            if case let .recording(since) = dictation.phase {
                HStack(spacing: 6) {
                    Circle().fill(theme.destructive).frame(width: 6, height: 6)
                    TimelineView(.periodic(from: since, by: 1)) { context in
                        let seconds = max(0, Int(context.date.timeIntervalSince(since)))
                        Text("\(seconds / 60):\(String(format: "%02d", seconds % 60))")
                            .monospacedDigit()
                    }
                }
                .font(.system(size: 14))
                .foregroundStyle(theme.mutedForeground)
                .padding(.trailing, 4)
                .frame(minHeight: Self.control)
                .accessibilityElement(children: .combine)
                .accessibilityLabel("Recording")
                // A stop-recording button: the send circle's shape in red, a white stop inside.
                Button { finishDictation(send: false) } label: {
                    ZStack {
                        Circle().fill(theme.destructive).frame(width: 30, height: 30)
                        ThreadGlyph(name: "stop", size: 12).foregroundStyle(.white)
                    }
                    .frame(width: 36, height: Self.control)
                    .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                .accessibilityLabel("Stop dictation")
                .accessibilityIdentifier("composer.stopDictation")
            } else {
                ProgressView().frame(width: 36, height: Self.control)
            }
            Button { finishDictation(send: true) } label: {
                ZStack {
                    Circle().fill(theme.primary).frame(width: 30, height: 30)
                    ThreadGlyph(name: "arrow-up", size: 16).foregroundStyle(theme.primaryForeground)
                }
                .opacity(sendAfterDictation ? 0.55 : 1)
                .frame(width: Self.control, height: Self.control)
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .disabled(sendAfterDictation)
            .accessibilityLabel("Send dictation")
            .accessibilityIdentifier("composer.sendDictation")
        }
    }

    /// Recording keeps the text field and its focus: the keyboard stays as it was.
    private func startDictation() {
        guard !draft.locked else { return }
        sendAfterDictation = false
        dictation.start()
    }

    /// The text goes in at the caret as it is when the transcript arrives. A send tapped while
    /// recording or transcribing sends the draft right after that.
    private func finishDictation(send: Bool) {
        if send { sendAfterDictation = true }
        guard case .recording = dictation.phase else { return }
        dictation.finish { text in
            let range = ComposerSelection.characterRange(selection, in: draft.text)
            let result = DictationInsertion.insert(text, into: draft.text, at: range)
            draft.text = result.text
            selection = TextSelection(insertionPoint: draft.text.index(draft.text.startIndex, offsetBy: result.cursor))
            guard sendAfterDictation else { return }
            sendAfterDictation = false
            // The parent reads the new draft on the next pass.
            Task { @MainActor in onSend() }
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

/// The composer's text metrics. The lab's input is 16pt on a 24pt line with `padding 10 12 10 0`
/// (2 below when expanded). SwiftUI cannot centre a glyph in a taller exact line box, so the
/// 24pt line is rebuilt from the font's own height: half the extra goes above and below each
/// line as padding, and the rest sits between lines as `lineSpacing`.
enum ComposerInputMetrics {
    // Lab `.m-composer-input`: 14/21.
    static let fontSize: CGFloat = 14
    static let lineBox: CGFloat = 21

    static var naturalLineHeight: CGFloat { UIFont.systemFont(ofSize: fontSize).lineHeight }
    static var lineSpacing: CGFloat { lineSpacing(natural: naturalLineHeight) }

    static func lineSpacing(natural: CGFloat) -> CGFloat { max(0, lineBox - natural) }
    private static func halfLeading(natural: CGFloat) -> CGFloat { lineSpacing(natural: natural) / 2 }

    /// Collapsed: the line box centred in the 44 pt control. Expanded: the lab's 14 above, 2 below.
    private static var collapsedPad: CGFloat { (44 - lineBox) / 2 }

    static func topInset(expanded: Bool, natural: CGFloat? = nil) -> CGFloat {
        (expanded ? 14 : collapsedPad) + halfLeading(natural: natural ?? naturalLineHeight)
    }

    static func bottomInset(expanded: Bool, natural: CGFloat? = nil) -> CGFloat {
        (expanded ? 2 : collapsedPad) + halfLeading(natural: natural ?? naturalLineHeight)
    }

    /// Collapsed with a + keeps the glyph's own inset as the gap (lab `padding-inline-start: 2px`).
    /// Expanded, the text starts where the + glyph is drawn: 12 pt into its 44 pt target, plus
    /// the glyph's own 3 pt inset.
    static func leadingInset(expanded: Bool, hasLeadingControl: Bool) -> CGFloat {
        if expanded { return 15 }
        return hasLeadingControl ? 2 : 12
    }

    static let expandedTrailingInset: CGFloat = 12

    /// Whether `text` needs more than one line in `room` points: a line break, or a line wider
    /// than the room less 12 pt of slack, so the layout switches before the text view itself
    /// would wrap at the one-row width.
    static func wraps(_ text: String, in room: CGFloat) -> Bool {
        guard room > 0 else { return false }
        if text.contains(where: \.isNewline) { return true }
        // Even the narrowest glyphs put this many characters past any one-row width.
        if text.utf16.count > 400 { return true }
        let width = (text as NSString).size(withAttributes: [.font: UIFont.systemFont(ofSize: fontSize)]).width
        return width > room - 12
    }
}

/// The keyboard-up sheet (lab `[data-keyboard="true"] .m-composer`). The box keeps its place: its
/// bottom is `bottomGutter` above the keyboard and its own 2 pt padding puts the controls 4 pt
/// clear. Only the surface grows: to the screen edges, and `keyboardCover` past the keyboard's top
/// edge, which the keyboard covers (the lab's 32 pt bottom padding, 28 of it hidden).
enum ComposerSheet {
    /// `ThreadComposer` and the new-thread screen inset the composer by this much on each side.
    static let screenInset: CGFloat = 12
    /// The screens' gap between the composer and the safe area or keyboard.
    static let bottomGutter: CGFloat = 2
    static let topRadius: CGFloat = 28
    /// The sheet's content inset, against the pill's 4: its controls sit 6 pt further out.
    static let controlsInset: CGFloat = -2
    static let keyboardCover: CGFloat = 28
    static var bottomBleed: CGFloat { bottomGutter + keyboardCover }
}

/// The sheet's 0.5 pt top edge in the border colour (the lab's `inset 0 0.5px 0`), clipped to its corners.
private struct ComposerSheetEdge: View {
    let shape: UnevenRoundedRectangle
    let color: Color
    let visible: Bool

    var body: some View {
        Rectangle()
            .fill(color)
            .frame(height: 0.5)
            .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .top)
            .clipShape(shape)
            .opacity(visible ? 1 : 0)
            .allowsHitTesting(false)
    }
}

/// A draft image: a 60 pt rounded square, filled and cropped, with a 22 pt dark remove circle 4 pt
/// in from the corner (Conn mobile's `ComposerAttachmentStrip`, 72 pt, radius 16, there). The
/// remove target is 44 pt. The picture is decoded once, at thumbnail size, off the main thread.
private struct ComposerImageThumbnail: View {
    let file: ComposerFile
    let locked: Bool
    let remove: () -> Void
    @Environment(\.connTheme) private var theme
    @Environment(\.displayScale) private var displayScale
    @State private var image: UIImage?

    private static let side: CGFloat = 60

    var body: some View {
        RoundedRectangle(cornerRadius: 14, style: .continuous)
            .fill(theme.card.opacity(0.78))
            .frame(width: Self.side, height: Self.side)
            .overlay {
                if let image {
                    Image(uiImage: image)
                        .resizable()
                        .scaledToFill()
                }
            }
            .clipShape(RoundedRectangle(cornerRadius: 14, style: .continuous))
            .overlay(alignment: .topTrailing) {
                Button(action: remove) {
                    ThreadGlyph(name: "close", size: 10)
                        .foregroundStyle(.white)
                        .frame(width: 22, height: 22)
                        .background(Color.black.opacity(0.55), in: Circle())
                        .frame(width: 44, height: 44)
                        .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                .disabled(locked)
                .offset(x: 7, y: -7)
                .accessibilityLabel("Remove \(file.name)")
            }
            .task(id: file.id) { image = await Self.thumbnail(of: file.url, pixels: Self.side * displayScale * 2) }
            .accessibilityElement(children: .contain)
    }

    private static func thumbnail(of url: URL, pixels: CGFloat) async -> UIImage? {
        await Task.detached(priority: .utility) {
            guard let source = CGImageSourceCreateWithURL(url as CFURL, nil) else { return nil }
            let options: [CFString: Any] = [
                kCGImageSourceCreateThumbnailFromImageAlways: true,
                kCGImageSourceCreateThumbnailWithTransform: true,
                kCGImageSourceShouldCacheImmediately: true,
                kCGImageSourceThumbnailMaxPixelSize: pixels,
            ]
            return CGImageSourceCreateThumbnailAtIndex(source, 0, options as CFDictionary)
                .map { UIImage(cgImage: $0) }
        }.value
    }
}

/// A draft file, as before: icon, name and a remove button in a rounded chip.
private struct ComposerFileChip: View {
    let file: ComposerFile
    let locked: Bool
    let remove: () -> Void
    @Environment(\.connTheme) private var theme

    var body: some View {
        HStack(spacing: 6) {
            ThreadGlyph(name: "file-text", size: 16)
            Text(file.name).lineLimit(1).truncationMode(.middle)
            Button(action: remove) {
                ThreadGlyph(name: "close", size: 14)
                    .frame(minWidth: 44, minHeight: 44)
                    .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .disabled(locked)
            .accessibilityLabel("Remove \(file.name)")
        }
        .font(.system(size: 13))
        .padding(.leading, 10)
        .background(theme.card.opacity(0.78), in: RoundedRectangle(cornerRadius: 12, style: .continuous))
    }
}

/// SwiftUI animation for a keyboard notification's duration and curve.
enum KeyboardMotion {
    /// The keyboard animates on UIKit's private curve 7, which SwiftUI cannot name. Measured on
    /// iOS 26, it tracks a critically damped spring of 22 rad/s (62% at 100 ms, 93% at 200 ms).
    /// The common stand-in (mass 3, stiffness 1000, damping 500) is at 33% when the keyboard stops.
    static var privateCurve: Animation {
        .interpolatingSpring(mass: 1, stiffness: 484, damping: 44, initialVelocity: 0)
    }

    static func animation(_ note: Notification) -> Animation {
        let info = note.userInfo
        let duration = info?[UIResponder.keyboardAnimationDurationUserInfoKey] as? Double ?? 0.25
        guard let raw = info?[UIResponder.keyboardAnimationCurveUserInfoKey] as? Int,
              let curve = UIView.AnimationCurve(rawValue: raw) else { return privateCurve }
        switch curve {
        case .easeInOut: return .easeInOut(duration: duration)
        case .easeIn: return .easeIn(duration: duration)
        case .easeOut: return .easeOut(duration: duration)
        case .linear: return .linear(duration: duration)
        @unknown default: return privateCurve
        }
    }
}

extension EnvironmentValues {
    /// Called when the composer changes height with `animation`. A UIKit host lays its new size
    /// out on the same animation; SwiftUI hosts animate it themselves.
    @Entry var composerResize: @MainActor (Animation) -> Void = { _ in }
}

enum ComposerSlot: Sendable { case none, leading, field, trailing }

private struct ComposerSlotKey: LayoutValueKey {
    static let defaultValue = ComposerSlot.none
}

extension View {
    fileprivate func composerSlot(_ slot: ComposerSlot) -> some View {
        layoutValue(key: ComposerSlotKey.self, value: slot)
    }
}

/// Lab `.m-composer`. Collapsed it is one row: + | text | controls. Expanded (`flex-wrap`) the text
/// takes the full first line and the + and the controls share a row below it, pinned to the
/// bottom. The text view's own height decides how far the box grows (one to `maxLines` lines);
/// the control row stays 44pt.
struct ComposerRowLayout: Layout {
    var expanded: Bool
    static let control: CGFloat = 44
    /// The lab's `gap: 8px` is also the wrapped row gap.
    static let rowGap: CGFloat = 8

    private struct Parts {
        var leading: LayoutSubview?
        var field: LayoutSubview?
        var trailing: LayoutSubview?
        init(_ subviews: Subviews) {
            for subview in subviews {
                switch subview[ComposerSlotKey.self] {
                case .leading: leading = subview
                case .field: field = subview
                case .trailing: trailing = subview
                case .none: break
                }
            }
        }
    }

    func sizeThatFits(proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) -> CGSize {
        let parts = Parts(subviews)
        let width = proposal.width ?? 320
        let leadingWidth = parts.leading?.sizeThatFits(.unspecified).width ?? 0
        let trailingSize = parts.trailing?.sizeThatFits(.unspecified) ?? .zero
        if expanded {
            let field = parts.field?.sizeThatFits(ProposedViewSize(width: width, height: nil)).height ?? 0
            return CGSize(width: width, height: field + Self.rowGap + Self.control)
        }
        let fieldWidth = max(0, width - leadingWidth - trailingSize.width)
        let field = parts.field?.sizeThatFits(ProposedViewSize(width: fieldWidth, height: nil)).height ?? 0
        return CGSize(width: width, height: max(Self.control, field, trailingSize.height))
    }

    func placeSubviews(in bounds: CGRect, proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) {
        let parts = Parts(subviews)
        let leadingWidth = parts.leading?.sizeThatFits(.unspecified).width ?? 0
        let trailingSize = parts.trailing?.sizeThatFits(.unspecified) ?? .zero
        if expanded {
            let field = parts.field?.sizeThatFits(ProposedViewSize(width: bounds.width, height: nil)).height ?? 0
            parts.field?.place(
                at: CGPoint(x: bounds.minX, y: bounds.minY), anchor: .topLeading,
                proposal: ProposedViewSize(width: bounds.width, height: field)
            )
            let rowTop = bounds.maxY - Self.control
            parts.leading?.place(
                at: CGPoint(x: bounds.minX, y: rowTop), anchor: .topLeading,
                proposal: ProposedViewSize(width: leadingWidth, height: Self.control)
            )
            parts.trailing?.place(
                at: CGPoint(x: bounds.maxX, y: rowTop), anchor: .topTrailing,
                proposal: ProposedViewSize(width: trailingSize.width, height: Self.control)
            )
        } else {
            let fieldWidth = max(0, bounds.width - leadingWidth - trailingSize.width)
            let field = parts.field?.sizeThatFits(ProposedViewSize(width: fieldWidth, height: nil)).height ?? 0
            parts.leading?.place(
                at: CGPoint(x: bounds.minX, y: bounds.midY), anchor: .leading,
                proposal: ProposedViewSize(width: leadingWidth, height: Self.control)
            )
            parts.field?.place(
                at: CGPoint(x: bounds.minX + leadingWidth, y: bounds.midY), anchor: .leading,
                proposal: ProposedViewSize(width: fieldWidth, height: field)
            )
            parts.trailing?.place(
                at: CGPoint(x: bounds.maxX, y: bounds.midY), anchor: .trailing,
                proposal: ProposedViewSize(width: trailingSize.width, height: trailingSize.height)
            )
        }
    }
}

/// Whether the software keyboard covers part of the screen, from the frame the system reports
/// in screen coordinates.
enum KeyboardOverlap {
    static func isUp(_ note: Notification) -> Bool {
        guard let frame = note.userInfo?[UIResponder.keyboardFrameEndUserInfoKey] as? CGRect else { return false }
        let screen = (note.object as? UIScreen)?.bounds.maxY ?? frame.maxY
        return frame.height > 0 && frame.minY < screen
    }
}

enum ComposerSelection {
    /// The caret or selection as character offsets in `text`, or `nil` without a single range.
    static func characterRange(_ selection: TextSelection?, in text: String) -> Range<Int>? {
        guard let selection, case let .selection(range) = selection.indices,
              range.lowerBound >= text.startIndex, range.upperBound <= text.endIndex else { return nil }
        return text.distance(from: text.startIndex, to: range.lowerBound)..<text.distance(from: text.startIndex, to: range.upperBound)
    }
}
