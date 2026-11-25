import DesignKit
import SwiftUI

struct AgentSummary: View {
    let title: String
    let text: String
    @State private var expanded = false
    @Environment(\.connTheme) private var theme

    @ScaledMetric(relativeTo: .footnote) private var size: CGFloat = 13

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
        .padding(.vertical, 10)
    }
}

struct MessageFooter: View {
    let text: String
    let timestamp: String?
    var trailingCopy = false
    @ScaledMetric(relativeTo: .footnote) private var size: CGFloat = 13
    @Environment(\.connTheme) private var theme
    var body: some View {
        HStack(spacing: 4) {
            if !trailingCopy { copyButton }
            if let date = threadDate(timestamp) { Text(date, style: .time).lineHeight(.exact(points: size * 16 / 13)) }
            if trailingCopy { copyButton }
        }.font(.system(size: size)).foregroundStyle(theme.mutedForeground)
    }

    @ViewBuilder private var copyButton: some View {
        if !text.isEmpty { CopyTextButton(label: "Copy message", text: text, message: true) }
    }
}

struct ThreadMessage: View {
    let text: String
    let date: String?
    let agent: Bool
    let files: [FfiAttachment]
    let detail: FfiFeedDetail?
    let store: CoreStore
    let onOpenThread: (String, String?) -> Void
    @Environment(\.connTheme) private var theme

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
                ThreadGlyph(name: "agent", size: 15)
                Text("Agent")
                Spacer()
                if let id = metadata.thread {
                    Button { onOpenThread(id, metadata.environment) } label: { Image(systemName: "arrow.up.right").padding(6) }
                        .accessibilityLabel("Open sender thread")
                }
            } content: {
                VStack(alignment: .leading, spacing: 3) {
                    AgentSummary(title: metadata.sender ?? "Message", text: text)
                    if !files.isEmpty { ThreadAttachments(files: files, store: store) }
                }
            }
        } else {
            VStack(alignment: .trailing, spacing: 2) {
                VStack(alignment: .leading, spacing: 3) {
                    if !displayText.isEmpty {
                        MarkdownView(source: displayText, fillsWidth: !files.isEmpty || !metadata.reviews.isEmpty, messageStyle: .user).fixedSize(horizontal: false, vertical: true)
                            .padding(.horizontal, 13)
                            .padding(.top, 7)
                            .padding(.bottom, files.isEmpty ? 9 : 7)
                    }
                    ForEach(metadata.reviews, id: \.contextId) { review in
                        if !review.text.isEmpty { Text(review.text).textSelection(.enabled).padding(.horizontal, 11) }
                        CodeCard(code: review.diff, language: "diff", title: [review.filePath, review.rangeLabel].filter { !$0.isEmpty }.joined(separator: " · "))
                    }
                    if !files.isEmpty { ThreadAttachments(files: files, store: store) }
                }
                .padding(3)
                .background(theme.messageSurface, in: .rect(cornerRadius: 14))
                MessageFooter(text: text, timestamp: date, trailingCopy: true)
                    .padding(.horizontal, 4)
            }
            .containerRelativeFrame(.horizontal, alignment: .trailing) { width, _ in (width - 32) * 0.8 }
            .frame(maxWidth: .infinity, alignment: .trailing)
        }
    }
}

struct TaskReceiptCard: View {
    let task: FfiTaskSummary
    @Environment(\.colorScheme) private var appearance
    @Environment(\.connTheme) private var theme

    var body: some View {
        let row = taskReceiptRow(task: task, nowMs: Int64(Date.now.timeIntervalSince1970 * 1000))
        ThreadCard {
            Image(systemName: "checklist")
                .overlay(alignment: .topTrailing) { StatusBadgeDot(dot: row.dot).offset(x: 4, y: -4) }
            Text(row.detail).lineLimit(2)
            Spacer(minLength: 0)
            if let pr = row.pullRequest, let url = URL(string: pr.url), ["https", "http"].contains(url.scheme) {
                Link(destination: url) {
                    Label("#\(pr.number)", systemImage: pr.state == .merged ? "arrow.triangle.merge" : "arrow.triangle.pull")
                }
                .foregroundStyle(pr.state == .merged ? AdaptiveColor.violet600400.color(appearance) :
                    pr.state == .closed ? theme.destructive : AdaptiveColor.emerald700300.color(appearance))
            }
        } content: {
            Text(row.title).font(.system(size: 14, weight: .medium)).padding(11)
        }
        .accessibilityElement(children: .contain)
        .accessibilityLabel(row.accessibilityLabel)
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
