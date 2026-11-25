import DesignKit
import SwiftUI

struct WorkGroupCard: View {
    let group: FfiWorkGroupTiming
    let entries: [FfiTimelineEntry]
    @Environment(\.connTheme) private var theme
    @Environment(\.colorScheme) private var appearance
    @State private var expanded = false
    /// When the running group started, from the server's elapsed time at the last snapshot.
    @State private var startedAt = Date()

    @ScaledMetric(relativeTo: .body) private var size: CGFloat = ThreadText.size

    private var title: String {
        if let label = group.durationLabel, !label.isEmpty {
            return "Worked for \(label)"
        }
        let count = entries.count
        return count == 1 ? "1 step" : "\(count) steps"
    }

    /// The paragraph gap (MarkdownView `blockSpacing`): the space above and below the divider.
    private var gap: CGFloat { size * 0.85 }

    var body: some View {
        VStack(alignment: .leading, spacing: gap) {
            if group.hasActive {
                // Mobile's `RunFoldWorking` and desktop's working row: plain text, no chevron.
                WorkingFoldLabel(since: startedAt, size: size)
            } else {
                Button {
                    withAnimation(Kit.Motion.fast) {
                        expanded.toggle()
                    }
                } label: {
                    // No fixed line box, so the chevron centres on the text's own glyphs.
                    HStack(alignment: .center, spacing: 4) {
                        Text(title)
                            .font(.system(size: size))
                            .foregroundStyle(theme.mutedForeground)
                        ThreadGlyph(name: expanded ? "chevron-down" : "chevron-right", size: 14)
                            .foregroundStyle(theme.mutedForeground)
                        Spacer()
                    }
                    .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
            }

            if expanded && !group.hasActive {
                // Lab `.m-work-log`: plain 44 pt rows split by subtle dividers, no cards.
                let steps = entries.filter {
                    if case .thinking = $0 { return true }
                    if case .tool = $0 { return true }
                    return false
                }
                VStack(alignment: .leading, spacing: 0) {
                    ForEach(Array(steps.enumerated()), id: \.element.entryId) { index, entry in
                        if index > 0 {
                            Rectangle()
                                .fill(threadDividerColor(theme, appearance).opacity(0.6))
                                .frame(height: 1)
                        }
                        switch entry {
                        case let .thinking(_, text, streaming, _, _):
                            WorkLogRow(title: streaming ? "Thinking…" : "Thought",
                                       status: streaming ? .running : .completed, duration: nil,
                                       detail: text.isEmpty ? nil : text, monospaced: false, size: size)
                        case let .tool(_, kind, title, detail, status, _, _, durationMs):
                            // Conn's own MCP tools get desktop's label and icon (`conn_tools`).
                            let conn = title.isEmpty ? nil : connToolLabel(title: title)
                            WorkLogRow(title: conn?.displayName ?? (title.isEmpty ? kind : title), status: status,
                                       duration: workDurationLabel(durationMs),
                                       detail: detail?.isEmpty == false ? detail : nil, monospaced: true, size: size,
                                       glyph: conn.map { $0.icon.glyph })
                        default:
                            EmptyView()
                        }
                    }
                }
            }

            Rectangle()
                .fill(threadDividerColor(theme, appearance))
                .frame(height: 1)
        }
        // The feed stacks items 22 apart; below the divider only the paragraph gap is wanted.
        .padding(.bottom, gap - 22)
        .accessibilityIdentifier("thread.workGroup.\(group.id)")
        .onAppear { anchor() }
        .onChange(of: group.durationMs) { anchor() }
    }

    private func anchor() {
        if group.hasActive, let ms = group.durationMs {
            startedAt = Date(timeIntervalSinceNow: -Double(ms) / 1000)
        }
    }
}

/// The working divider when no work group is running yet: the same row and rule as a group's.
struct WorkingFold: View {
    let since: Date
    @Environment(\.connTheme) private var theme
    @Environment(\.colorScheme) private var appearance
    @ScaledMetric(relativeTo: .body) private var size: CGFloat = ThreadText.size

    var body: some View {
        let gap = size * 0.85
        VStack(alignment: .leading, spacing: gap) {
            WorkingFoldLabel(since: since, size: size)
            Rectangle().fill(threadDividerColor(theme, appearance)).frame(height: 1)
        }
        .padding(.bottom, gap)
    }
}

/// "Working for 59s", ticking once a second (mobile `RunFoldWorking`, desktop `format_working_elapsed`).
struct WorkingFoldLabel: View {
    let since: Date
    let size: CGFloat
    @Environment(\.connTheme) private var theme

    var body: some View {
        TimelineView(.periodic(from: .now, by: 1)) { context in
            let seconds = max(0, Int(context.date.timeIntervalSince(since)))
            Text("Working for \(seconds < 60 ? "\(seconds)s" : "\(seconds / 60)m \(seconds % 60)s")")
                .font(.system(size: size))
                .monospacedDigit()
                .foregroundStyle(theme.mutedForeground)
                .frame(maxWidth: .infinity, alignment: .leading)
        }
        .accessibilityIdentifier("thread.workingFold")
    }
}

/// Conn's live row (`ThinkingTimelineRow`): an icon and a shimmering label, never a spinner.
struct LiveWorkRow: View {
    let label: String
    /// Superheroicons `thinking`, as the lab and desktop (`icons::BRAIN`) draw it.
    var glyph = "thinking"
    @ScaledMetric(relativeTo: .body) private var size: CGFloat = ThreadText.size
    @Environment(\.connTheme) private var theme

    var body: some View {
        HStack(spacing: 6) {
            // No padded box: the glyph starts on the feed's text edge.
            ThreadGlyph(name: glyph, size: 16)
                .foregroundStyle(theme.mutedForeground)
            ShimmerText(label, size: size)
        }
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(label)
        .accessibilityIdentifier("thread.liveWork")
    }
}

/// Conn's `live-tool-shine`: a 72 pt highlight band sweeps the label in 12 steps over 1.35 s, then
/// rests 1.45 s (mobile `work-shimmer-steps.ts`). The band is a gradient mask moved by a timeline
/// that fires 12 times per 2.8 s cycle, so the text never repaints at frame rate. Reduce Motion
/// shows plain muted text.
struct ShimmerText: View {
    let text: String
    let size: CGFloat
    @Environment(\.connTheme) private var theme
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    init(_ text: String, size: CGFloat) {
        self.text = text
        self.size = size
    }

    var body: some View {
        let font = Font.system(size: size)
        Text(text)
            .font(font)
            .lineLimit(1)
            .foregroundStyle(theme.mutedForeground)
            .overlay {
                if !reduceMotion {
                    TimelineView(ShimmerSchedule()) { context in
                        Text(text)
                            .font(font)
                            .lineLimit(1)
                            .foregroundStyle(theme.foreground)
                            .mask { ShimmerBand(progress: ShimmerSchedule.progress(at: context.date)) }
                    }
                    .accessibilityHidden(true)
                }
            }
    }
}

private struct ShimmerBand: View {
    /// 0 is the band's left edge off the text's left, 1 is its left edge past the text's right.
    let progress: Double
    private static let width: CGFloat = 72

    var body: some View {
        GeometryReader { geometry in
            LinearGradient(
                stops: [
                    .init(color: .white.opacity(0), location: 0),
                    .init(color: .white.opacity(0.12), location: 0.15),
                    .init(color: .white.opacity(0.55), location: 0.35),
                    .init(color: .white, location: 0.5),
                    .init(color: .white.opacity(0.55), location: 0.65),
                    .init(color: .white.opacity(0.12), location: 0.85),
                    .init(color: .white.opacity(0), location: 1),
                ],
                startPoint: .leading, endPoint: .trailing
            )
            .frame(width: Self.width)
            .offset(x: -Self.width + progress * (geometry.size.width + Self.width))
            .frame(width: geometry.size.width, height: geometry.size.height, alignment: .leading)
        }
    }
}

/// Fires at each of the shimmer's 12 steps and not between, so the view updates about 4 times a
/// second on average and sleeps through the rest.
struct ShimmerSchedule: TimelineSchedule {
    static let steps = 12
    static let sweep: TimeInterval = 1.35
    static let pause: TimeInterval = 1.45
    private static var cycle: TimeInterval { sweep + pause }
    private static var step: TimeInterval { sweep / Double(steps) }

    /// The band's progress at `date`: the last step reached in the sweep, then fully past the text
    /// through the pause. All shimmers share the clock, so they sweep together.
    static func progress(at date: Date) -> Double {
        let phase = date.timeIntervalSinceReferenceDate.truncatingRemainder(dividingBy: cycle)
        return Double(min(Int(phase / step + 1e-6), steps)) / Double(steps)
    }

    func entries(from start: Date, mode: Mode) -> Entries {
        Entries(cursor: start.timeIntervalSinceReferenceDate, first: true)
    }

    struct Entries: Sequence, IteratorProtocol {
        var cursor: TimeInterval
        var first: Bool

        mutating func next() -> Date? {
            if first {
                first = false
                return Date(timeIntervalSinceReferenceDate: cursor)
            }
            let cycle = ShimmerSchedule.cycle
            let step = ShimmerSchedule.step
            let cycleStart = (cursor / cycle).rounded(.down) * cycle
            let nextStep = ((cursor - cycleStart) / step + 1e-6).rounded(.down) + 1
            cursor = nextStep <= Double(ShimmerSchedule.steps)
                ? cycleStart + nextStep * step
                : cycleStart + cycle + step
            return Date(timeIntervalSinceReferenceDate: cursor)
        }
    }
}

struct TimelineEntryRow: View {
    let threadId: String
    let entry: FfiTimelineEntry
    @Bindable var store: CoreStore
    let detail: FfiFeedDetail?
    let interactive: Bool
    let onOpenThread: (String, String?) -> Void
    let onTemplate: (String) -> Void
    @Environment(\.connTheme) private var theme

    var body: some View {
        switch detail {
        case let .html(attachment, title, height):
            ThreadEmbed(store: store, thread: threadId, item: entry.entryId, attachment: attachment, title: title, height: CGFloat(height), mcp: false)
        case let .mcp(sourceThread, attachment, title):
            ThreadEmbed(store: store, thread: sourceThread, item: entry.entryId, attachment: attachment, title: title, height: 260, mcp: true)
        case let .task(task):
            TaskReceiptCard(task: task)
        default:
            entryView
        }
    }

    @ViewBuilder private var entryView: some View {
        switch entry {
        case let .user(_, text, date, agent, _, _, files):
            ThreadMessage(text: text, date: date, agent: agent, files: files,
                          detail: detail, store: store, threadId: threadId, onOpenThread: onOpenThread)
        case let .queuedUser(_, _, _, text, date, agent, files):
            ThreadMessage(text: text, date: date, agent: agent, files: files,
                          detail: detail, store: store, threadId: threadId, onOpenThread: onOpenThread)
        case let .assistant(_, markdown, streaming, timestamp, _, status):
            VStack(alignment: .leading, spacing: 6) {
                MarkdownView(source: markdown, messageStyle: .assistant, onTemplate: onTemplate)
                if streaming { KitStatusIcon(.working, size: 12, label: "Streaming") }
                else {
                    HStack {
                        if status == .failed { Label("Response interrupted", systemImage: "exclamationmark.circle").font(.caption) }
                        MessageFooter(text: markdown, timestamp: timestamp)
                    }
                }
            }

        case let .thinking(_, text, streaming, _, _):
            ThinkingRow(text: text, streaming: streaming)

        case let .tool(_, kind, title, detail, status, _, _, durationMs):
            ToolRow(kind: kind, title: title, detail: detail, status: status, durationMs: durationMs)

        case let .approval(_, _, title, detail):
            // The pending approval itself sits above the composer (`PendingApprovalCard`); the
            // feed keeps a work row for it, like Conn mobile's "Approval requested".
            // Mobile draws this row with a static `lock` icon (`thread-work-log.tsx:159,411`);
            // no spinner, so a waiting approval never repaints.
            ApprovalWorkRow(title: title, detail: detail)

        case let .userInputRequest(_, _, _, _, _, pending, answers, _, _):
            QuestionRow(pending: pending, answers: answers)

        case let .secretRequest(id, label, reason, url, placeholder, _, status, pending, _):
            SecretRequestCard(
                threadId: threadId,
                turnItemId: id,
                label: label,
                reason: reason,
                url: url,
                placeholder: placeholder,
                status: status,
                pending: pending,
                interactive: interactive,
                store: store
            )

        case let .proposedPlan(_, _, title, markdown, display, _, _, streaming, _, _):
            ProposedPlanCard(title: title, markdown: markdown, display: display, streaming: streaming)
        case let .subagent(_, child, title, role, status, label, _, summary, remoteLabel, _, started, ended):
            let metadata = subagentMetadata
            ThreadCard {
                // Lab `SubagentCard`: `<model> · <effort>`, the run time at the right. As on desktop,
                // the header opens the child thread.
                ThreadCardHeaderLink(open: (metadata.thread ?? child).map { destination in
                    { onOpenThread(destination, metadata.environment) }
                }, label: "Open " + title) {
                    // GPUI's fixed info and success colours (lab `--thread-info`, `--thread-success`).
                    ProviderIcon(driver: metadata.provider, size: 14).cardStatusDot(
                        status == .completed ? Color(rgbHex: 0x00BC7D) : status == .failed ? theme.destructive : Color(rgbHex: 0x2B7FFF))
                    let elapsed = threadElapsed(started, ended)
                    Text([metadata.model ?? role, metadata.effort, elapsed == nil ? label : nil, remoteLabel]
                        .compactMap { $0 }.filter { !$0.isEmpty }.joined(separator: " · ")).lineLimit(2)
                    Spacer(minLength: 0)
                    if let elapsed { Text(elapsed).monospacedDigit().fixedSize() }
                }
            } content: { AgentSummary(title: title, text: summary ?? "") }
        case let .turnCheckpoint(_, _, ordinal, fileCount, additions, deletions, files):
            TurnCheckpointCard(fileCount: Int(fileCount), additions: additions, deletions: deletions, files: files,
                               ordinal: ordinal, threadId: threadId, store: store)

        case let .notice(_, text, isError):
            KitNotice(text, icon: isError ? .warning : .info, tone: isError ? .error : .info)

        case let .other(_, label):
            KitBadge(label)
        }
    }
    private var subagentMetadata: (provider: String?, model: String?, effort: String?, environment: String?, thread: String?) {
        if case let .subagent(provider, model, effort, environment, thread) = detail {
            return (provider, model, effort, environment, thread)
        }
        return (nil, nil, nil, nil, nil)
    }

}

/// A card header row that opens a thread when tapped, in place of a separate open button.
struct ThreadCardHeaderLink<Content: View>: View {
    let open: (() -> Void)?
    let label: String
    @ViewBuilder let content: Content

    var body: some View {
        let row = HStack(spacing: 8) { content }
            .padding(.trailing, 6)
            .frame(maxWidth: .infinity, minHeight: 30, alignment: .leading)
            .contentShape(Rectangle())
        if let open {
            Button(action: open) { row }
                .buttonStyle(.plain)
                .accessibilityLabel(label)
        } else {
            row
        }
    }
}

struct ThinkingRow: View {
    let text: String
    let streaming: Bool

    var body: some View {
        KitCollapsibleCard(
            streaming ? "Thinking…" : "Thought",
            status: streaming ? .working : .ok,
            expandable: !text.isEmpty
        ) {
            Text(text)
                .font(.kitDetail)
                .foregroundStyle(.secondary)
                .textSelection(.enabled)
        }
    }
}

struct ToolRow: View {
    let kind: String
    let title: String
    let detail: String?
    let status: FfiItemStatus
    let durationMs: UInt64?

    private var mappedStatus: KitStatusIcon.Status {
        switch status {
        case .running: .working
        case .completed: .ok
        case .failed: .error
        }
    }

    private var durationLabel: String? {
        guard let ms = durationMs, ms > 0 else { return nil }
        if ms < 1000 { return "\(ms)ms" }
        return String(format: "%.1fs", Double(ms) / 1000.0)
    }

    var body: some View {
        let hasDetail = !(detail?.isEmpty ?? true)
        KitCollapsibleCard(
            title.isEmpty ? kind : title,
            status: mappedStatus,
            statusLabel: kind,
            trailingText: durationLabel,
            expandable: hasDetail
        ) {
            if let detail, !detail.isEmpty {
                if kind == "file_change" && detail.contains("\n") {
                    CodeCard(code: detail, language: "diff")
                } else { ScrollView(.horizontal, showsIndicators: true) {
                    Text(detail)
                        .font(.kitMono)
                        .foregroundStyle(.secondary)
                        .textSelection(.enabled)
                } }
            }
        }
    }
}

/// "Approval requested" in the feed, with mobile's static lock icon.
private struct ApprovalWorkRow: View {
    let title: String
    let detail: String?
    @Environment(\.connTheme) private var theme

    var body: some View {
        KitCollapsibleCard(
            title.isEmpty ? "Approval requested" : title,
            expandable: !(detail?.isEmpty ?? true),
            leading: {
                ConnIcon("lock")
                    .font(.system(size: 13))
                    .foregroundStyle(theme.mutedForeground)
            },
            trailing: { EmptyView() }
        ) {
            if let detail, !detail.isEmpty {
                Text(detail)
                    .font(.kitMono)
                    .foregroundStyle(.secondary)
                    .textSelection(.enabled)
            }
        }
    }
}

/// A question's feed row, like Conn mobile's "Input requested" work row: it expands to the
/// answers (`QuestionAnswerHistory`). The open question has no row; the panel above the
/// composer asks it.
private struct QuestionRow: View {
    let pending: Bool
    let answers: [FfiUserInputAnswer]
    @Environment(\.connTheme) private var theme

    var body: some View {
        KitCollapsibleCard(
            "Input requested",
            status: pending ? .working : .ok,
            statusLabel: "question",
            trailingText: nil,
            expandable: !answers.isEmpty
        ) {
            VStack(alignment: .leading, spacing: 8) {
                ForEach(answers, id: \.questionId) { answer in
                    VStack(alignment: .leading, spacing: 4) {
                        if !answer.question.isEmpty {
                            Text(answer.question)
                                .font(.system(size: 14))
                                .foregroundStyle(theme.mutedForeground)
                        }
                        if !answer.answer.isEmpty {
                            Text(answer.answer)
                                .font(.system(size: 14))
                                .foregroundStyle(theme.mutedForeground)
                                .padding(.leading, 12)
                        }
                    }
                }
            }
            .textSelection(.enabled)
        }
    }
}

private struct SecretRequestCard: View {
    let threadId: String
    let turnItemId: String
    let label: String
    let reason: String
    let url: String?
    let placeholder: String?
    let status: FfiSecretRequestStatus
    let pending: Bool
    let interactive: Bool
    @Bindable var store: CoreStore
    @Environment(\.connTheme) private var theme

    @State private var secret = ""
    @State private var submitting = false

    var body: some View {
        ThreadCard {
            Label("Secret request", systemImage: "key")
            Spacer()
            if pending && interactive {
                let canSave = !secret.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty && !submitting
                HStack(spacing: 6) {
                    Button("Decline", role: .destructive) { answer(nil) }
                        .foregroundStyle(theme.destructive)
                        .disabled(submitting)
                    Button { answer(secret) } label: {
                        Text("Save")
                            .foregroundStyle(canSave ? theme.primaryForeground : theme.mutedForeground)
                            .padding(.horizontal, 10)
                            .frame(minHeight: 24)
                            .background(canSave ? theme.primary : theme.card.mix(with: theme.foreground, by: 0.14),
                                        in: Capsule())
                    }
                    .disabled(!canSave)
                }
                .buttonStyle(.plain)
            } else { Text(statusLabel) }
        } content: {
            VStack(alignment: .leading, spacing: 8) {
                if !label.isEmpty { Text(label).font(.system(size: 14, weight: .medium)) }
                if !reason.isEmpty { Text(reason).font(.kitDetail).foregroundStyle(theme.mutedForeground) }
                if pending && interactive {
                    if let url, let source = URL(string: url), source.scheme == "https" {
                        Link("Open secret provider", destination: source)
                    }
                    SecureField(placeholder ?? "Enter secret…", text: $secret)
                        .textFieldStyle(.roundedBorder).textInputAutocapitalization(.never)
                        .autocorrectionDisabled().privacySensitive()
                        .disabled(submitting)
                }
            }.padding(11)
        }
        .onDisappear { secret = "" }
    }

    private func answer(_ value: String?) {
        guard pending && interactive && !submitting else { return }
        submitting = true
        secret = ""
        Task {
            await store.answerSecretRequest(threadId: threadId, turnItemId: turnItemId, secret: value)
            submitting = false
        }
    }

    private var statusLabel: String {
        switch status {
        case .pending: "Pending"
        case .saved: "Saved"
        case .declined: "Declined"
        case .cancelled: "Cancelled"
        }
    }
}

extension FfiTimelineEntry {
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

private func workDurationLabel(_ ms: UInt64?) -> String? {
    guard let ms, ms > 0 else { return nil }
    return ms < 1000 ? "\(ms)ms" : String(format: "%.1fs", Double(ms) / 1000)
}

/// One step of an expanded "Worked for" log (lab `.m-work-log li`): status glyph, title, duration and a
/// chevron when there is detail to show; a tap reveals the detail under the row.
private struct WorkLogRow: View {
    let title: String
    let status: FfiItemStatus
    let duration: String?
    let detail: String?
    let monospaced: Bool
    let size: CGFloat
    /// A finished Conn tool shows its own icon in place of the check.
    var glyph: String? = nil
    @Environment(\.connTheme) private var theme
    @State private var open = false

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            Button {
                guard detail != nil else { return }
                withAnimation(Kit.Motion.fast) { open.toggle() }
            } label: {
                HStack(spacing: 10) {
                    Group {
                        switch status {
                        case .running: KitStatusIcon(.working, size: 16, label: "Running")
                        case .completed: ThreadGlyph(name: glyph ?? "check-circle", size: 16).foregroundStyle(theme.mutedForeground)
                        case .failed: ThreadGlyph(name: "error-circle", size: 16).foregroundStyle(theme.destructive)
                        }
                    }
                    .frame(width: 16, height: 16)
                    Text(title).font(.system(size: size)).foregroundStyle(theme.foreground).lineLimit(1)
                    Spacer(minLength: 8)
                    if let duration {
                        Text(duration).font(.system(size: size).monospacedDigit()).foregroundStyle(theme.mutedForeground)
                    }
                    if detail != nil {
                        ThreadGlyph(name: open ? "chevron-down" : "chevron-right", size: 14)
                            .foregroundStyle(theme.mutedForeground.opacity(0.6))
                    }
                }
                .frame(minHeight: 44)
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            if open, let detail {
                if monospaced {
                    // Tool output as a code card: no wrapping, sideways scrolling, capped height; JSON
                    // pretty-printed (nested JSON strings decoded in place) and highlighted.
                    let pretty = PrettyJSON.format(detail)
                    CodeCard(code: pretty ?? detail, language: pretty == nil ? nil : "json",
                             maxHeight: 320, codeSize: ThreadText.codeSize - 1)
                        .padding(.bottom, 10)
                } else {
                    // A step smaller than the thread text, with 1.6x lines, flush with the row's left edge.
                    let detailSize = size * 0.9
                    Text(detail)
                        .font(.system(size: detailSize))
                        .lineHeight(.exact(points: detailSize * 1.6))
                        .foregroundStyle(theme.mutedForeground)
                        .textSelection(.enabled)
                        .padding(.bottom, 10)
                }
            }
        }
    }
}

/// Pretty-prints tool output that is JSON, with 2-space indents. A string value that is itself a JSON
/// object or array (an MCP result's `content`, say) is decoded and printed in place, so no escaped
/// quotes show. Anything that isn't JSON returns nil and shows as it is.
enum PrettyJSON {
    static func format(_ text: String) -> String? {
        let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard let first = trimmed.first, first == "{" || first == "[", trimmed.utf8.count <= 256 * 1024,
              let object = parse(trimmed) else { return nil }
        let expanded = expand(object, depth: 0)
        guard JSONSerialization.isValidJSONObject(expanded),
              let data = try? JSONSerialization.data(
                  withJSONObject: expanded, options: [.prettyPrinted, .sortedKeys, .withoutEscapingSlashes]),
              let pretty = String(data: data, encoding: .utf8) else { return nil }
        return pretty
    }

    private static func parse(_ text: String) -> Any? {
        try? JSONSerialization.jsonObject(with: Data(text.utf8), options: [.fragmentsAllowed])
    }

    private static func expand(_ value: Any, depth: Int) -> Any {
        guard depth < 8 else { return value }
        switch value {
        case let dict as [String: Any]:
            return dict.mapValues { expand($0, depth: depth + 1) }
        case let array as [Any]:
            return array.map { expand($0, depth: depth + 1) }
        case let string as String:
            let trimmed = string.trimmingCharacters(in: .whitespacesAndNewlines)
            guard let first = trimmed.first, first == "{" || first == "[",
                  let inner = parse(trimmed), inner is [String: Any] || inner is [Any] else { return string }
            return expand(inner, depth: depth + 1)
        default:
            return value
        }
    }
}

extension FfiConnToolIcon {
    /// The thread glyph for each Conn tool icon (GPUI's `conn_icon_path`).
    var glyph: String {
        switch self {
        case .connMark: "conn-mark"
        case .browser: "globe"
        case .device: "phone"
        case .pullRequest: "pull-request"
        case .credential: "key"
        }
    }
}
