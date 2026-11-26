import DesignKit
import SwiftUI

/// A queued message open in the composer (desktop `EditingQueuedRun`): the draft it replaced comes
/// back on Cancel or Save. New files picked while editing are the draft's own files.
struct QueuedEdit {
    let runId: String
    let savedText: String
    let savedFiles: [ComposerFile]
    /// The message's files still kept; removing one here drops it on Save.
    var attachments: [FfiAttachment]
    let originalAttachmentIds: [String]

    /// `nil` when no file was removed: the server then keeps the message's files.
    var keptAttachmentIds: [String]? {
        let ids = attachments.map(\.id)
        return ids == originalAttachmentIds ? nil : ids
    }
}

/// What the feed shows for a queued run while its action is on its way: a removed row is hidden
/// and an edited one shows its new text, until the server's snapshot agrees or the action fails.
enum QueuedOverride: Equatable {
    case removed
    case edited(String)
}

/// One server-queued message (`QueuedUser` with a run id), as desktop's `render_queued_user_row`.
/// `runId` is the queued run id; pending outbox rows (no run id) stay plain user bubbles.
struct QueuedMessage: Identifiable, Equatable {
    let id: String
    let runId: String
    let text: String
    let createdAt: String
    let attachments: [FfiAttachment]

    init?(_ entry: FfiTimelineEntry) {
        guard case let .queuedUser(id, runId, _, text, createdAt, byAgent, attachments) = entry,
              !runId.isEmpty, !byAgent else { return nil }
        self.id = id
        self.runId = runId
        self.text = text
        self.createdAt = createdAt
        self.attachments = attachments
    }
}

/// Desktop's queue at the bottom of the thread: the queued rows, oldest first, and past three a
/// "Show all N queued" / "Show fewer" toggle (`QUEUE_VISIBLE_ROWS`, `render_queued_toggle`).
struct QueuedMessagesSection: View {
    let threadId: String
    let messages: [QueuedMessage]
    @Bindable var store: CoreStore
    /// A question or approval holds the composer, so Edit waits (mobile `editBlocked`).
    let editBlocked: Bool
    @Environment(\.feedExpansion) private var expansion
    @State private var localExpanded = false
    private var expanded: Bool { expansion?.isOpen("queued:" + threadId) ?? localExpanded }

    /// Desktop `QUEUE_VISIBLE_ROWS`: a longer queue shows the first two and the toggle.
    static let visibleRows = 3

    private var composer: ComposerDraft { store.composerDraft(.thread(threadId)) }

    private var shown: [QueuedMessage] {
        messages.compactMap { message in
            switch store.queuedOverrides[message.runId] {
            case .removed: return nil
            case let .edited(text):
                return QueuedMessage(copying: message, text: text)
            case nil: return message
            }
        }
    }

    var body: some View {
        let rows = shown
        let collapsible = rows.count > Self.visibleRows
        let visible = collapsible && !expanded ? Array(rows.prefix(Self.visibleRows - 1)) : rows
        VStack(alignment: .trailing, spacing: 0) {
            ForEach(Array(visible.enumerated()), id: \.element.id) { index, message in
                QueuedMessageRow(
                    message: message,
                    store: store,
                    threadId: threadId,
                    editing: composer.queuedEdit?.runId == message.runId,
                    busy: store.queuedBusy.contains(message.runId),
                    editBlocked: editBlocked
                )
                // Desktop: 12 between queued rows, 8 above the toggle.
                .padding(.bottom, index == visible.count - 1 ? (collapsible ? 8 : 0) : 12)
            }
            if collapsible {
                // No animation: growing rows under the feed's end pin made the pin and the jump
                // circle's inset chase each other mid-animation.
                QueuedToggle(total: rows.count, expanded: expanded) {
                    if let expansion { expansion.toggle("queued:" + threadId) } else { localExpanded.toggle() }
                }
            }
        }
        .frame(maxWidth: .infinity, alignment: .trailing)
        .onChange(of: messages) { _, current in
            store.settleQueuedOverrides(current)
            // A run that started or left the queue can't be saved any more (desktop
            // `clear_edit_queued_if_missing`); its text stays in the composer.
            if let edit = composer.queuedEdit, !current.contains(where: { $0.runId == edit.runId }) {
                composer.queuedEdit = nil
            }
        }
    }
}

extension QueuedMessage {
    fileprivate init(copying message: QueuedMessage, text: String) {
        id = message.id
        runId = message.runId
        self.text = text
        createdAt = message.createdAt
        attachments = message.attachments
    }
}

/// One queued message: the user bubble's shape, on desktop's raised fill with a dashed border
/// (primary while it is open in the composer). Its time stays in view below it; a tap adds the
/// copy button. A long press offers Send now, Edit and Remove, then Copy and Select text.
struct QueuedMessageRow: View {
    let message: QueuedMessage
    let store: CoreStore
    let threadId: String
    let editing: Bool
    let busy: Bool
    let editBlocked: Bool
    @Environment(\.connTheme) private var theme
    @ScaledMetric(relativeTo: .body) private var size: CGFloat = ThreadText.size

    private static let shape = RoundedRectangle(cornerRadius: 20, style: .continuous)

    var body: some View {
        MessageReveal(text: message.text, timestamp: message.createdAt, trailing: true, pinnedFooter: true) {
            Button("Send now", systemImage: "arrow.up") {
                Task { await store.sendQueuedNow(threadId: threadId, runId: message.runId) }
            }
            .disabled(busy || editing)
            Button("Edit", systemImage: "pencil") {
                store.composerDraft(.thread(threadId)).beginQueuedEdit(message)
            }
            .disabled(busy || editing || editBlocked)
            Button("Remove", systemImage: "xmark", role: .destructive) {
                Task { await store.removeQueuedMessage(threadId: threadId, runId: message.runId) }
            }
            .disabled(busy)
        } accessory: {
            if editing {
                let metaSize = size * (ThreadText.size - 2) / ThreadText.size
                Text("Editing in the composer")
                    .font(.system(size: metaSize))
                    .foregroundStyle(theme.foreground)
                    .padding(.horizontal, 4)
                Button("Cancel") { store.composerDraft(.thread(threadId)).cancelQueuedEdit() }
                    .font(.system(size: metaSize))
                    .buttonStyle(.plain)
                    .foregroundStyle(theme.mutedForeground)
                    .padding(.horizontal, 6)
                    .frame(minHeight: 32)
                    .contentShape(Rectangle())
                    .accessibilityLabel("Cancel editing queued message")
                    .accessibilityIdentifier("queued.cancelEdit")
            }
        } content: {
            bubble
        }
        .opacity(busy ? 0.6 : 1)
        .containerRelativeFrame(.horizontal, alignment: .trailing) { width, _ in (width - 32) * 0.9 }
        .frame(maxWidth: .infinity, alignment: .trailing)
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("queued.row.\(message.runId)")
    }

    private var bubble: some View {
        VStack(alignment: .leading, spacing: 3) {
            if !message.text.isEmpty {
                ViewThatFits(in: .horizontal) {
                    if message.attachments.isEmpty {
                        MarkdownView(source: message.text, fillsWidth: false, messageStyle: .user)
                            .fixedSize()
                    }
                    MarkdownView(source: message.text, messageStyle: .user)
                        .fixedSize(horizontal: false, vertical: true)
                }
                .padding(.horizontal, 13)
                .padding(.top, 9)
                .padding(.bottom, message.attachments.isEmpty ? 9 : 7)
            }
            if !message.attachments.isEmpty {
                ThreadAttachments(files: message.attachments, store: store, thread: threadId)
            }
        }
        .padding(3)
        .background(theme.shellRaised, in: Self.shape)
        // GPUI's dashed border: 1 px, 2 px dashes with 1 px gaps; muted at 40%, primary at 60%
        // while the message is open in the composer.
        .overlay {
            Self.shape.strokeBorder(
                editing ? theme.primary.opacity(0.6) : theme.mutedForeground.opacity(0.4),
                style: StrokeStyle(lineWidth: 1, dash: [2, 1])
            )
        }
        .accessibilityElement(children: .combine)
        .accessibilityLabel("Queued message: \(String(message.text.prefix(120)))")
        .accessibilityIdentifier("queued.bubble.\(message.runId)")
    }
}

/// Desktop's `render_queued_toggle`: a right-aligned, muted, medium-weight label with a chevron
/// that turns over when the whole queue shows.
private struct QueuedToggle: View {
    let total: Int
    let expanded: Bool
    let action: () -> Void
    @ScaledMetric(relativeTo: .body) private var size: CGFloat = ThreadText.size
    @Environment(\.connTheme) private var theme

    var body: some View {
        let metaSize = size * (ThreadText.size - 2) / ThreadText.size
        Button(action: action) {
            HStack(spacing: 2) {
                Text(expanded ? "Show fewer" : "Show all \(total) queued")
                ThreadGlyph(name: "chevron-down", size: metaSize + 1)
                    .rotationEffect(.degrees(expanded ? 180 : 0))
            }
            .font(.system(size: metaSize, weight: .medium))
            .foregroundStyle(theme.mutedForeground)
            .frame(minHeight: 32)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .padding(.trailing, 14)
        .accessibilityIdentifier("queued.toggle")
    }
}

extension ComposerDraft {
    /// Opens a queued message in the composer (desktop `begin_edit_queued`): the draft so far is
    /// kept for Cancel and Save, and the field takes the message's text.
    func beginQueuedEdit(_ message: QueuedMessage) {
        let saved = queuedEdit.map { ($0.savedText, $0.savedFiles) } ?? (text, files)
        queuedEdit = QueuedEdit(
            runId: message.runId,
            savedText: saved.0,
            savedFiles: saved.1,
            attachments: message.attachments,
            originalAttachmentIds: message.attachments.map(\.id)
        )
        error = nil
        files = []
        text = message.text
        focusRequest &+= 1
    }

    /// Leaves edit mode and brings the earlier draft back (desktop `cancel_edit_queued`).
    func cancelQueuedEdit() {
        guard let edit = queuedEdit else { return }
        queuedEdit = nil
        text = edit.savedText
        files = edit.savedFiles
    }
}

/// The composer's edit-mode header (desktop's "Editing queued message" bar, mobile's
/// `ComposerQueuedEditBanner`), with the message's own files, each removable.
struct ComposerQueuedEditBar: View {
    @Bindable var draft: ComposerDraft
    @ScaledMetric(relativeTo: .body) private var size: CGFloat = ThreadText.size
    @Environment(\.connTheme) private var theme

    var body: some View {
        if let edit = draft.queuedEdit {
            let metaSize = size * (ThreadText.size - 2) / ThreadText.size
            VStack(alignment: .leading, spacing: 6) {
                HStack(spacing: 6) {
                    ThreadGlyph(name: "work-compose", size: metaSize)
                        .foregroundStyle(theme.mutedForeground)
                    Text("Editing queued message")
                        .font(.system(size: metaSize, weight: .medium))
                        .foregroundStyle(theme.foreground)
                        .lineLimit(1)
                    Spacer(minLength: 8)
                    Button("Cancel") { draft.cancelQueuedEdit() }
                        .font(.system(size: metaSize))
                        .foregroundStyle(theme.mutedForeground)
                        .buttonStyle(.plain)
                        .frame(minWidth: 44, minHeight: 32)
                        .contentShape(Rectangle())
                        .disabled(draft.locked)
                        .accessibilityLabel("Cancel editing queued message")
                        .accessibilityIdentifier("composer.cancelQueuedEdit")
                }
                if !edit.attachments.isEmpty {
                    ScrollView(.horizontal) {
                        HStack(spacing: 6) {
                            ForEach(edit.attachments, id: \.id) { attachment in
                                QueuedEditAttachmentChip(attachment: attachment, size: metaSize) {
                                    draft.queuedEdit?.attachments.removeAll { $0.id == attachment.id }
                                }
                            }
                        }
                    }
                    .scrollIndicators(.hidden)
                }
            }
            .padding(.horizontal, 12)
            .padding(.top, 8)
            // Keeps the Cancel button's own identifier under the composer's.
            .accessibilityElement(children: .contain)
            .accessibilityIdentifier("composer.queuedEdit")
        }
    }
}

/// Desktop's `composer-queued-att` chip: icon, name and a remove button.
private struct QueuedEditAttachmentChip: View {
    let attachment: FfiAttachment
    let size: CGFloat
    let remove: () -> Void
    @Environment(\.connTheme) private var theme

    var body: some View {
        HStack(spacing: 6) {
            ThreadGlyph(name: "file-text", size: 14).foregroundStyle(theme.mutedForeground)
            Text(attachment.name).lineLimit(1).truncationMode(.middle).frame(maxWidth: 160)
            Button(action: remove) {
                ThreadGlyph(name: "close", size: 11)
                    .frame(width: 32, height: 32)
                    .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .accessibilityLabel("Remove \(attachment.name)")
        }
        .font(.system(size: size))
        .foregroundStyle(theme.foreground)
        .padding(.leading, 8)
        .frame(height: 28)
        .background(theme.foreground.opacity(0.06), in: RoundedRectangle(cornerRadius: 8, style: .continuous))
    }
}
