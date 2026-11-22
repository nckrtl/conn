import DesignKit
import SwiftUI

struct ThreadView: View {
    @Bindable var store: CoreStore
    let threadId: String
    let title: String
    let branch: String?

    @State private var draft = ""
    @State private var stickToBottom = true
    @FocusState private var composerFocused: Bool

    private var snapshot: FfiThreadSnapshot? {
        guard let current = store.openThread, current.threadId == threadId else { return nil }
        return current
    }

    private var scrollFingerprint: String {
        guard let snapshot else { return "loading" }
        let last = snapshot.entries.last.map(entryFingerprint) ?? "empty"
        return "\(snapshot.entries.count):\(snapshot.working):\(last)"
    }

    var body: some View {
        ScrollViewReader { proxy in
            ScrollView {
                LazyVStack(alignment: .leading, spacing: Kit.Space.l) {
                    if let error = store.lastError, !error.isEmpty {
                        KitNotice(error, icon: .warning, tone: .error)
                    }

                    if let snapshot {
                        if snapshot.entries.isEmpty {
                            Text("No messages in this thread yet.")
                                .font(.kitDetail)
                                .foregroundStyle(.tertiary)
                                .frame(maxWidth: .infinity)
                                .padding(.vertical, 48)
                        } else {
                            ForEach(snapshot.entries, id: \.entryId) { entry in
                                TimelineEntryRow(entry: entry)
                            }
                        }

                        if snapshot.working {
                            HStack(spacing: Kit.Space.m) {
                                KitStatusIcon(.working, size: 14, label: "Working")
                                Text("Working…")
                                    .font(.kitDetail)
                                    .foregroundStyle(.secondary)
                            }
                            .padding(.top, Kit.Space.xs)
                        }
                    } else {
                        HStack(spacing: Kit.Space.m) {
                            KitStatusIcon(.working, size: 16, label: "Loading")
                            Text("Loading timeline…")
                                .font(.kitDetail)
                                .foregroundStyle(.secondary)
                        }
                        .frame(maxWidth: .infinity)
                        .padding(.vertical, 48)
                    }

                    Color.clear
                        .frame(height: 1)
                        .id("timeline-bottom")
                }
                .padding(.horizontal, Kit.contentInset)
                .padding(.top, Kit.Space.l)
                .padding(.bottom, Kit.Space.l)
            }
            .background(Color.kitContent.ignoresSafeArea())
            .scrollDismissesKeyboard(.interactively)
            .onScrollGeometryChange(for: Bool.self) { geo in
                let maxOffset = max(0, geo.contentSize.height - geo.containerSize.height)
                return geo.contentOffset.y >= maxOffset - 80
            } action: { _, nearBottom in
                stickToBottom = nearBottom
            }
            .onChange(of: scrollFingerprint) { _, _ in
                if stickToBottom {
                    withAnimation(Kit.Motion.fast) {
                        proxy.scrollTo("timeline-bottom", anchor: .bottom)
                    }
                }
            }
            .safeAreaInset(edge: .bottom, spacing: 0) {
                composerBar(scrollProxy: proxy)
            }
        }
        .navigationTitle(title.isEmpty ? "Thread" : title)
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            if snapshot?.working == true {
                ToolbarItem(placement: .topBarTrailing) {
                    KitStatusIcon(.working, size: 16, label: "Working")
                }
            }
        }
        .task(id: threadId) {
            store.openThread(threadId)
        }
        .onDisappear {
            store.closeThread(threadId)
        }
    }

    private func composerBar(scrollProxy: ScrollViewProxy) -> some View {
        let canSend = !draft.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty && !store.isSending

        return VStack(spacing: 0) {
            Divider().overlay(Color.kitSeparator)
            HStack(alignment: .bottom, spacing: Kit.Space.m) {
                TextField("Message…", text: $draft, axis: .vertical)
                    .font(.kitBody)
                    .lineLimit(1...5)
                    .focused($composerFocused)
                    .padding(.horizontal, Kit.Space.l)
                    .padding(.vertical, Kit.Space.m)
                    .background(
                        RoundedRectangle(cornerRadius: 18, style: .continuous)
                            .fill(Color.kitSurface)
                    )
                    .overlay(
                        RoundedRectangle(cornerRadius: 18, style: .continuous)
                            .strokeBorder(Color.kitBorder, lineWidth: 0.5)
                    )
                    .accessibilityIdentifier("thread.composerField")

                Button {
                    let message = draft
                    stickToBottom = true
                    Task {
                        let sent = await store.sendMessage(threadId: threadId, text: message)
                        if sent {
                            draft = ""
                            composerFocused = false
                            withAnimation(Kit.Motion.fast) {
                                scrollProxy.scrollTo("timeline-bottom", anchor: .bottom)
                            }
                        }
                    }
                } label: {
                    ZStack {
                        Circle()
                            .fill(canSend ? Color.kitInk : Color.kitTile)
                            .frame(width: 36, height: 36)
                        if store.isSending {
                            KitStatusIcon(.working, size: 16, label: "Sending")
                        } else {
                            KitIconImage(.arrowRight, size: 14)
                                .foregroundStyle(canSend ? Color.kitOnInk : .secondary)
                        }
                    }
                }
                .buttonStyle(.plain)
                .disabled(!canSend)
                .accessibilityLabel("Send")
                .accessibilityIdentifier("thread.sendButton")
            }
            .padding(.horizontal, Kit.contentInset)
            .padding(.vertical, Kit.Space.m)
            .background(Color.kitContent)
        }
    }

    private func entryFingerprint(_ entry: FfiTimelineEntry) -> String {
        switch entry {
        case let .user(id, text, _, _, _, _, _): "u:\(id):\(text.count)"
        case let .queuedUser(id, _, _, text, _, _, _): "q:\(id):\(text.count)"
        case let .assistant(id, markdown, streaming, _, _, _): "a:\(id):\(streaming):\(markdown.count)"
        case let .thinking(id, text, streaming, _, _): "th:\(id):\(streaming):\(text.count)"
        case let .tool(id, _, title, detail, status, _, _, _): "t:\(id):\(status):\(title.count):\(detail?.count ?? 0)"
        case let .approval(id, _, title, _): "ap:\(id):\(title.count)"
        case let .userInputRequest(id, _, _, questions, _, pending, answers, _, _):
            "ui:\(id):\(pending):\(questions.count):\(answers.count)"
        case let .secretRequest(id, label, _, _, _, _, status, pending, _):
            "sec:\(id):\(status):\(pending):\(label.count)"
        case let .proposedPlan(id, _, title, markdown, _, _, _, streaming, _, _):
            "plan:\(id):\(streaming):\(title.count):\(markdown.count)"
        case let .subagent(id, _, title, _, status, _, _, summary, _, _, _, _):
            "sub:\(id):\(status):\(title.count):\(summary?.count ?? 0)"
        case let .turnCheckpoint(id, _, _, fileCount, additions, deletions, _):
            "cp:\(id):\(fileCount):\(additions):\(deletions)"
        case let .notice(id, text, isError): "n:\(id):\(isError):\(text.count)"
        case let .other(id, label): "o:\(id):\(label.count)"
        }
    }
}

private struct TimelineEntryRow: View {
    let entry: FfiTimelineEntry

    var body: some View {
        switch entry {
        case let .user(_, text, _, createdByAgent, _, _, _):
            HStack {
                Spacer(minLength: 48)
                VStack(alignment: .trailing, spacing: Kit.Space.xs) {
                    if createdByAgent {
                        Text("Agent")
                            .font(.kitDetail)
                            .foregroundStyle(.secondary)
                    }
                    Text(text)
                        .font(.kitBody)
                        .foregroundStyle(Color.kitOnInk)
                        .textSelection(.enabled)
                        .padding(.horizontal, Kit.Space.xl)
                        .padding(.vertical, Kit.Space.m + 2)
                        .background(
                            RoundedRectangle(cornerRadius: 16, style: .continuous)
                                .fill(Color.kitInk)
                        )
                }
            }

        case let .queuedUser(_, _, _, text, _, _, _):
            Text("Queued: \(text)")
                .font(.kitDetail)
                .foregroundStyle(.secondary)
                .padding(.horizontal, Kit.Space.m)
                .padding(.vertical, Kit.Space.xs)
                .background(
                    Capsule()
                        .fill(Color.kitTile)
                )

        case let .assistant(_, markdown, streaming, _, _, _):
            VStack(alignment: .leading, spacing: Kit.Space.xs) {
                markdownText(markdown)
                    .font(.kitBody)
                    .foregroundStyle(.primary)
                    .textSelection(.enabled)
                    .frame(maxWidth: .infinity, alignment: .leading)
                if streaming {
                    KitStatusIcon(.working, size: 12, label: "Streaming")
                }
            }

        case let .thinking(_, text, streaming, _, _):
            ThinkingRow(text: text, streaming: streaming)

        case let .tool(_, kind, title, detail, status, _, _, _):
            ToolRow(kind: kind, title: title, detail: detail, status: status)

        case let .approval(_, _, title, detail):
            HStack(alignment: .top, spacing: Kit.Space.m) {
                KitStatusIcon(.warning, size: 16, label: "Approval needed")
                    .padding(.top, 2)
                VStack(alignment: .leading, spacing: Kit.Space.xs) {
                    Text(title)
                        .font(.kitLabel.weight(.medium))
                        .foregroundStyle(.primary)
                    if let detail, !detail.isEmpty {
                        Text(detail)
                            .font(.kitDetail)
                            .foregroundStyle(.secondary)
                            .lineLimit(4)
                    }
                }
                Spacer(minLength: 0)
            }
            .padding(Kit.Space.l)
            .background(
                RoundedRectangle(cornerRadius: 12, style: .continuous)
                    .fill(Color.kitSurface)
            )
            .overlay(
                RoundedRectangle(cornerRadius: 12, style: .continuous)
                    .strokeBorder(Color.kitSeparator, lineWidth: 0.5)
            )

        case let .userInputRequest(_, _, title, questions, _, _, _, _, _):
            let label = title ?? questions.first?.question ?? "Question"
            pillRow("Question: \(label)")

        case let .secretRequest(_, label, _, _, _, _, _, _, _):
            pillRow(label.isEmpty ? "Secret request" : "Secret: \(label)")

        case let .proposedPlan(_, _, title, _, _, _, _, _, _, _):
            pillRow(title.isEmpty ? "Proposed plan" : "Plan: \(title)")

        case let .subagent(_, _, title, _, _, statusLabel, _, _, _, _, _, _):
            pillRow("Subagent: \(title) · \(statusLabel)")

        case let .turnCheckpoint(_, _, _, fileCount, additions, deletions, _):
            pillRow("\(fileCount) changed files +\(additions) -\(deletions)")

        case let .notice(_, text, isError):
            pillRow(isError ? "Error: \(text)" : text)

        case let .other(_, label):
            pillRow(label)
        }
    }

    private func pillRow(_ label: String) -> some View {
        Text(label)
            .font(.kitDetail)
            .foregroundStyle(.secondary)
            .padding(.horizontal, Kit.Space.m)
            .padding(.vertical, Kit.Space.xs)
            .background(
                Capsule()
                    .fill(Color.kitTile)
            )
    }

    private func markdownText(_ source: String) -> Text {
        let options = AttributedString.MarkdownParsingOptions(
            interpretedSyntax: .inlineOnlyPreservingWhitespace
        )
        if let parsed = try? AttributedString(markdown: source, options: options) {
            return Text(parsed)
        }
        return Text(source)
    }
}

private struct ThinkingRow: View {
    let text: String
    let streaming: Bool
    @State private var expanded = false

    var body: some View {
        VStack(alignment: .leading, spacing: Kit.Space.s) {
            Button {
                withAnimation(Kit.Motion.fast) {
                    expanded.toggle()
                }
            } label: {
                HStack(spacing: Kit.Space.s) {
                    if streaming {
                        KitStatusIcon(.working, size: 13, label: "Thinking")
                    } else {
                        KitIconImage(.setup, size: 13)
                            .foregroundStyle(.secondary)
                    }
                    Text(streaming ? "Thinking…" : "Thought")
                        .font(.kitDetail.weight(.medium))
                        .foregroundStyle(.secondary)
                    Spacer()
                    KitIconImage(.chevronRight, size: 10)
                        .foregroundStyle(.tertiary)
                        .rotationEffect(.degrees(expanded ? 90 : 0))
                }
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain)

            if expanded, !text.isEmpty {
                Text(text)
                    .font(.kitDetail)
                    .foregroundStyle(.secondary)
                    .textSelection(.enabled)
            }
        }
        .padding(.horizontal, Kit.Space.l)
        .padding(.vertical, Kit.Space.m)
        .background(
            RoundedRectangle(cornerRadius: 10, style: .continuous)
                .fill(Color.kitSurface)
        )
        .overlay(
            RoundedRectangle(cornerRadius: 10, style: .continuous)
                .strokeBorder(Color.kitSeparator, lineWidth: 0.5)
        )
    }
}

private struct ToolRow: View {
    let kind: String
    let title: String
    let detail: String?
    let status: FfiItemStatus
    @State private var expanded = false

    var body: some View {
        VStack(alignment: .leading, spacing: Kit.Space.s) {
            Button {
                if let detail, !detail.isEmpty {
                    withAnimation(Kit.Motion.fast) {
                        expanded.toggle()
                    }
                }
            } label: {
                HStack(spacing: Kit.Space.m) {
                    KitStatusIcon(mappedStatus, size: 14, label: kind)
                    Text(title.isEmpty ? kind : title)
                        .font(.kitDetail.weight(.medium))
                        .foregroundStyle(.primary)
                        .lineLimit(expanded ? nil : 1)
                        .multilineTextAlignment(.leading)
                    Spacer(minLength: Kit.Space.s)
                    if let detail, !detail.isEmpty {
                        KitIconImage(.chevronRight, size: 10)
                            .foregroundStyle(.tertiary)
                            .rotationEffect(.degrees(expanded ? 90 : 0))
                    }
                }
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain)

            if expanded, let detail, !detail.isEmpty {
                Text(detail)
                    .font(.kitMono)
                    .foregroundStyle(.secondary)
                    .textSelection(.enabled)
                    .lineLimit(20)
            }
        }
        .padding(.horizontal, Kit.Space.l)
        .padding(.vertical, Kit.Space.m)
        .background(
            RoundedRectangle(cornerRadius: 10, style: .continuous)
                .fill(Color.kitSurface)
        )
        .overlay(
            RoundedRectangle(cornerRadius: 10, style: .continuous)
                .strokeBorder(Color.kitSeparator, lineWidth: 0.5)
        )
    }

    private var mappedStatus: KitStatusIcon.Status {
        switch status {
        case .running: .working
        case .completed: .ok
        case .failed: .error
        }
    }
}

private extension FfiTimelineEntry {
    var entryId: String {
        switch self {
        case let .user(id, _, _, _, _, _, _): id
        case let .queuedUser(id, _, _, _, _, _, _): id
        case let .assistant(id, _, _, _, _, _): id
        case let .thinking(id, _, _, _, _): id
        case let .tool(id, _, _, _, _, _, _, _): id
        case let .approval(id, _, _, _): id
        case let .userInputRequest(id, _, _, _, _, _, _, _, _): id
        case let .secretRequest(id, _, _, _, _, _, _, _, _): id
        case let .proposedPlan(id, _, _, _, _, _, _, _, _, _): id
        case let .subagent(id, _, _, _, _, _, _, _, _, _, _, _): id
        case let .turnCheckpoint(id, _, _, _, _, _, _): id
        case let .notice(id, _, _): id
        case let .other(id, _): id
        }
    }
}
