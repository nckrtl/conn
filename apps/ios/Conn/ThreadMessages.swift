import DesignKit
import SwiftUI

struct AgentSummary: View {
    let title: String
    let text: String
    @State private var expanded = false
    @Environment(\.connTheme) private var theme

    @ScaledMetric(relativeTo: .body) private var size: CGFloat = ThreadText.size

    private var preview: String {
        let options = AttributedString.MarkdownParsingOptions(interpretedSyntax: .inlineOnlyPreservingWhitespace)
        let excerpt = String(text.prefix(2048))
        let parsed = try? AttributedString(markdown: excerpt, options: options)
        return (parsed.map { String($0.characters) } ?? excerpt).split(whereSeparator: \.isWhitespace).joined(separator: " ")
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            if text.isEmpty {
                Text(title).fontWeight(.medium)
            } else {
                Button { expanded.toggle() } label: {
                    VStack(alignment: .leading, spacing: 6) {
                        HStack(alignment: .firstTextBaseline) {
                            Text(title).fontWeight(.medium)
                            Spacer(minLength: 6)
                            ThreadGlyph(name: "chevron-down", size: 14)
                                .rotationEffect(.degrees(expanded ? 180 : 0))
                                .foregroundStyle(theme.mutedForeground)
                        }
                        if !expanded {
                            Text(verbatim: preview).foregroundStyle(theme.mutedForeground).lineLimit(2)
                        }
                    }.contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                .accessibilityLabel(title)
                .accessibilityValue(expanded ? "Expanded" : "Collapsed")
                if expanded { MarkdownView(source: text, messageStyle: .assistant) }
            }
        }
        .font(.system(size: size))
        .lineHeight(.exact(points: size * 1.625))
        .padding(.horizontal, 11)
        .padding(.top, 10)
        // The exact line height puts all its extra room under the last line, not around it, so the
        // bottom gives that back and the text sits as far from the bottom edge as from the top.
        .padding(.bottom, max(0, 10 - (size * 1.625 - UIFont.systemFont(ofSize: size).lineHeight)))
    }
}

struct MessageFooter: View {
    let text: String
    let timestamp: String?
    var trailingCopy = false
    var showsCopy = false
    /// The copy button after the time (user bubbles, right-aligned) or before it (agent messages).
    var copyAfter = true
    // Message times sit a point below the thread text: 13 pt on Polar (thread text 14).
    @ScaledMetric(relativeTo: .body) private var fullSize: CGFloat = ThreadText.size
    private var size: CGFloat { trailingCopy ? fullSize * (ThreadText.size - 1) / ThreadText.size : fullSize }
    @Environment(\.connTheme) private var theme
    var body: some View {
        HStack(spacing: 4) {
            // Under an agent message the icon's left edge is the text's: the 16 pt glyph sits 4 pt
            // inside its 24 pt tap target; under a user bubble it ends on the bubble's right edge.
            if showsCopy && !copyAfter { copyButton.padding(.leading, -4) }
            if let date = threadDate(timestamp) {
                Text(date, style: .time).lineHeight(.exact(points: size * 16 / 13))
            }
            if showsCopy && copyAfter { copyButton.padding(.trailing, -4) }
        }
        .font(.system(size: size))
        .foregroundStyle(theme.mutedForeground)
    }

    @ViewBuilder private var copyButton: some View {
        if !text.isEmpty { CopyTextButton(label: "Copy message", text: text, message: true, glyphSize: 16) }
    }
}

/// A tap on a message shows its copy button and time below it; another tap hides them.
/// Simultaneous, so links, code-card buttons and the feed's keyboard dismissal still get the tap.
struct MessageReveal<Content: View>: View {
    let text: String
    let timestamp: String?
    /// User bubbles: footer on the right, time then copy.
    var trailing = false
    var enabled = true
    @ViewBuilder let content: Content
    @State private var revealed = false
    @State private var selecting = false

    /// "Today, 8:45", "Yesterday, 21:10" or "26 Nov, 08:45": the long-press menu's header.
    static func sentLabel(_ timestamp: String?) -> String {
        guard let date = threadDate(timestamp) else { return "" }
        let time = date.formatted(date: .omitted, time: .shortened)
        let calendar = Calendar.current
        if calendar.isDateInToday(date) { return "Today, " + time }
        if calendar.isDateInYesterday(date) { return "Yesterday, " + time }
        return date.formatted(.dateTime.day().month(.abbreviated)) + ", " + time
    }
    @ScaledMetric(relativeTo: .body) private var messageSize: CGFloat = ThreadText.size

    var body: some View {
        VStack(alignment: trailing ? .trailing : .leading, spacing: (messageSize * 0.85 - 1) / 2) {
            content
                .contentShape(.contextMenuPreview, RoundedRectangle(cornerRadius: 20, style: .continuous))
                // A long press shows when it was sent, Copy and Select text (like ChatGPT).
                .contextMenu {
                    Section(MessageReveal<Content>.sentLabel(timestamp)) {
                        Button("Copy", systemImage: "doc.on.doc") {
                            UIPasteboard.general.string = text
                        }
                        Button("Select text", systemImage: "selection.pin.in.out") {
                            selecting = true
                        }
                    }
                }
                .sheet(isPresented: $selecting) { SelectTextSheet(text: text) }
                .contentShape(Rectangle())
                .simultaneousGesture(TapGesture().onEnded {
                    guard enabled else { return }
                    UISelectionFeedbackGenerator().selectionChanged()
                    withAnimation(.easeOut(duration: 0.18)) { revealed.toggle() }
                })
                .accessibilityAction(named: revealed ? "Hide details" : "Show time and copy") {
                    withAnimation { revealed.toggle() }
                }
            if revealed {
                MessageFooter(text: text, timestamp: timestamp, trailingCopy: true, showsCopy: true, copyAfter: trailing)
                    .environment(\.layoutDirection, .leftToRight)
                    // Under a user bubble, the time ends where the bottom-right corner starts to
                    // curve (its 20 pt radius, set in a little for the glyphs' own inset).
                    .padding(.trailing, trailing ? 14 : 0)
                    .frame(maxWidth: .infinity, alignment: trailing ? .trailing : .leading)
                    .transition(.opacity.combined(with: .move(edge: .top)))
            }
        }
    }
}

struct ThreadMessage: View {
    let text: String
    let date: String?
    let agent: Bool
    let files: [FfiAttachment]
    let detail: FfiFeedDetail?
    let store: CoreStore
    let threadId: String
    let onOpenThread: (String, String?) -> Void
    @Environment(\.connTheme) private var theme
    @ScaledMetric(relativeTo: .body) private var messageSize: CGFloat = ThreadText.size

    private var metadata: (sender: String?, thread: String?, environment: String?, reviews: [FfiReviewExcerpt]) {
        guard case let .message(sender, thread, env, reviews) = detail else { return (nil, nil, nil, []) }
        let localName = env == nil || env == store.environmentId ? store.shell?.threads.first(where: { $0.id == thread })?.title : nil
        return (sender ?? localName, thread, env, reviews)
    }

    private var displayText: String {
        guard !metadata.reviews.isEmpty else { return text }
        var result = text
        for review in metadata.reviews {
            let id = NSRegularExpression.escapedPattern(for: review.contextId)
            let reference = #"\[[^\]]*\]\(t3-context://v1/review-comment/"# + id + #"\)"#
            result = result.replacingOccurrences(of: reference, with: "", options: .regularExpression)
        }
        return result.trimmingCharacters(in: .whitespacesAndNewlines)
    }

    var body: some View {
        if agent {
            ThreadCard {
                ThreadCardHeaderLink(open: metadata.thread.map { id in
                    { onOpenThread(id, metadata.environment) }
                }, label: "Open sender thread") {
                    ThreadGlyph(name: "agent", size: 15)
                    Text("Agent")
                    Spacer()
                }
            } content: {
                VStack(alignment: .leading, spacing: 3) {
                    AgentSummary(title: metadata.sender ?? "Message", text: text)
                    if !files.isEmpty { ThreadAttachments(files: files, store: store, thread: threadId) }
                }
            }
        } else {
            // The copy and time row sits close under the bubble: half the agent footer's gap.
            // A tap on the bubble shows its time and copy button below it.
            MessageReveal(text: text, timestamp: date, trailing: true) {
                VStack(alignment: .leading, spacing: 3) {
                    if !displayText.isEmpty {
                        ViewThatFits(in: .horizontal) {
                            if files.isEmpty && metadata.reviews.isEmpty {
                                MarkdownView(source: displayText, fillsWidth: false, messageStyle: .user)
                                    .fixedSize()
                            }
                            MarkdownView(source: displayText, messageStyle: .user)
                                .fixedSize(horizontal: false, vertical: true)
                        }
                            .padding(.horizontal, 13)
                            // Lab `.m-user-bubble`: 12 above and below text-only (3 + 9 here); with
                            // files or images the bottom is 7 above the attachment.
                            .padding(.top, 9)
                            .padding(.bottom, files.isEmpty ? 9 : 7)
                    }
                    ForEach(metadata.reviews, id: \.contextId) { review in
                        if !review.text.isEmpty { Text(review.text).textSelection(.enabled).padding(.horizontal, 11) }
                        CodeCard(code: review.diff, language: "diff", title: [review.filePath, review.rangeLabel].filter { !$0.isEmpty }.joined(separator: " · "))
                    }
                    if !files.isEmpty { ThreadAttachments(files: files, store: store, thread: threadId) }
                }
                .padding(3)
                // Lab: the corner toward the time is nearly square.
                .background(theme.messageSurface, in: UnevenRoundedRectangle(
                    topLeadingRadius: 20, bottomLeadingRadius: 20, bottomTrailingRadius: 20, topTrailingRadius: 20,
                    style: .continuous))
            }
            .containerRelativeFrame(.horizontal, alignment: .trailing) { width, _ in (width - 32) * 0.9 }
            .frame(maxWidth: .infinity, alignment: .trailing)
        }
    }
}

struct TaskReceiptCard: View {
    let task: FfiTaskSummary
    @ScaledMetric(relativeTo: .body) private var size: CGFloat = ThreadText.size
    @Environment(\.colorScheme) private var appearance
    @Environment(\.connTheme) private var theme

    var body: some View {
        let row = taskReceiptRow(task: task, nowMs: Int64(Date.now.timeIntervalSince1970 * 1000))
        ThreadCard {
            ThreadGlyph(name: "checklist-16", size: 16)
                .frame(width: 14, height: 14)
                .cardStatusDot(dotColor(row.dot))
            Text(row.detail).lineLimit(2)
            Spacer(minLength: 0)
            if let pr = row.pullRequest, let url = URL(string: pr.url), ["https", "http"].contains(url.scheme) {
                Link(destination: url) {
                    HStack(spacing: 3) {
                        ThreadGlyph(name: pr.state == .merged ? "merge" : "pull-request", size: size)
                        Text("#\(pr.number)")
                    }
                }
                .foregroundStyle(pr.state == .merged ? AdaptiveColor.violet600400.color(appearance) :
                    pr.state == .closed ? theme.destructive : AdaptiveColor.emerald700300.color(appearance))
            }
        } content: {
            Text(row.title).font(.system(size: size, weight: .medium)).padding(11)
        }
        .accessibilityElement(children: .contain)
        .accessibilityLabel(row.accessibilityLabel)
    }

    private func dotColor(_ dot: FfiTaskDot) -> Color {
        switch dot {
        case .working: AdaptiveColor.sky600400.color(appearance)
        case .waiting: theme.mutedForeground
        case .done: AdaptiveColor.emerald600400.color(appearance)
        case .failed: theme.destructive
        }
    }
}

struct ProposedPlanCard: View {
    let title: String
    let markdown: String
    let display: String
    let streaming: Bool
    @State private var saving = false
    @State private var error: String?

    var body: some View {
        ThreadCard {
            Label("Proposed plan", systemImage: "checklist")
            if streaming { KitStatusIcon(.working, size: 12, label: "Streaming") }
            Spacer()
            CopyTextButton(label: "Copy plan", text: markdown)
            Button { saving = true } label: { Image(systemName: "square.and.arrow.down").padding(6) }
                .accessibilityLabel("Save plan")
        } content: {
            VStack(alignment: .leading, spacing: 8) {
                Text(title).font(.headline)
                MarkdownView(source: display)
                if let error { Text(error).font(.caption) }
            }.padding(11)
        }
        .fileExporter(isPresented: $saving, document: MarkdownDocument(text: markdown),
                      contentType: MarkdownDocument.readableContentTypes[0], defaultFilename: "plan.md") { result in
            if case let .failure(failure) = result { error = failure.localizedDescription }
        }
    }
}

extension FfiThreadSnapshot {
    /// History pages are projected independently. Prefer the linked child when it and its wake meet.
    mutating func removeRepeatedDelegatedResults() {
        guard !delegatedTaskIds.isEmpty else { return }
        struct ResultKey: Hashable {
            let task: String
            let body: String
        }
        let tasks = delegatedTaskIds
        var seen = Set(entries.compactMap { entry -> ResultKey? in
            guard case let .subagent(id, _, _, _, _, _, true, body?, _, _, _, _) = entry,
                  let task = tasks[id] else { return nil }
            return ResultKey(task: task, body: body.trimmingCharacters(in: .whitespacesAndNewlines))
        })
        entries.removeAll { entry in
            guard case let .user(id, body, _, true, _, _, _) = entry, let task = tasks[id] else { return false }
            return !seen.insert(ResultKey(task: task, body: body.trimmingCharacters(in: .whitespacesAndNewlines))).inserted
        }
    }
}

/// The whole message in a read-only text view, to select any part of it (the menu's Select text).
struct SelectTextSheet: View {
    let text: String
    @Environment(\.dismiss) private var dismiss

    var body: some View {
        NavigationStack {
            SelectableTextView(text: text)
                .padding(.horizontal, 12)
                .navigationTitle("Select text")
                .navigationBarTitleDisplayMode(.inline)
                .toolbar {
                    ToolbarItem(placement: .topBarTrailing) { Button(role: .close) { dismiss() } }
                }
        }
        .presentationDetents([.medium, .large])
    }
}

private struct SelectableTextView: UIViewRepresentable {
    let text: String

    func makeUIView(context: Context) -> UITextView {
        let view = UITextView()
        view.isEditable = false
        view.isSelectable = true
        view.backgroundColor = .clear
        view.font = .systemFont(ofSize: 16)
        view.textColor = .label
        view.textContainerInset = UIEdgeInsets(top: 12, left: 0, bottom: 24, right: 0)
        return view
    }

    func updateUIView(_ view: UITextView, context: Context) {
        if view.text != text { view.text = text }
    }
}
