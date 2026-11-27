import Observation
import SwiftUI

struct PullRequestRow: Codable, Identifiable, Hashable {
    let projectId, projectTitle, host, repository, title, url, headBranch, baseBranch: String
    let number: Int
    let isDraft: Bool
    struct Actor: Codable, Hashable { let login: String }
    struct LabelValue: Codable, Hashable { let name: String }
    let author: Actor?
    let labels: [LabelValue]?
    let checksState: String?
    let updatedAt: String?
    var id: String { url }
    var ref: [String: Any] {
        ["projectId": projectId, "host": host, "repository": repository, "number": number]
    }
    var status: String {
        if isDraft { return "Draft" }
        switch checksState {
        case "pending": return "Checks running"
        case "passing": return "Checks passed"
        case "failing": return "Checks failed"
        default: return "Open"
        }
    }
}

fileprivate struct PullRequestStats: Decodable {
    struct Stat: Decodable {
        let projectId, repository: String
        let number, additions, deletions: Int
    }
    let stats: [Stat]
}

private struct PullRequestPage: Decodable {
    struct ProjectError: Decodable { let projectTitle, message: String }
    let entries: [PullRequestRow]
    let errors: [ProjectError]
    let nextCursors: [String: String]
    let truncated: Bool
}

struct PullRequestsTabView: View {
    let store: CoreStore
    let searchQuery: String
    @Bindable var model: WorkspacePullRequests
    @Environment(\.connTheme) private var theme
    @Environment(\.colorScheme) private var colorScheme

    var body: some View {
        let candidates = model.candidates(query: searchQuery)
        let selected = model.selected(query: searchQuery)
        // The title, counts and status filter live in the navigation bar (`WorkspaceRootView`).
        ScrollView {
            LazyVStack(spacing: 0) {
                if model.loading { ProgressView() }
                if let notice = model.notice { Text(notice).foregroundStyle(theme.mutedForeground).padding() }
                if !model.loading && model.notice == nil && selected.isEmpty {
                    let empty = candidates.isEmpty && searchQuery.isEmpty
                    VStack(spacing: 4) {
                        Text(empty ? "No pull requests" : "No matching pull requests")
                            .font(.system(size: 16, weight: .medium))
                            .foregroundStyle(theme.foreground)
                        if empty {
                            Text("Pull requests from connected environments will appear here.")
                                .font(.system(size: 15)).foregroundStyle(theme.mutedForeground)
                        }
                    }.multilineTextAlignment(.center).padding(.horizontal, 32).padding(.vertical, 40)
                }
                ForEach(selected) { row in
                    NavigationLink(value: WorkspaceRoute.pullRequest(row)) {
                        ProjectListRow(project: row.projectTitle, status: statusDot(row), title: row.title) {
                            if let stat = model.stats[row.id] {
                                HStack(spacing: 4) {
                                    Text("+\(stat.additions)").foregroundStyle(AdaptiveColor.emerald700300.color(colorScheme))
                                    Text("−\(stat.deletions)").foregroundStyle(theme.destructive)
                                }.font(.system(size: 14).monospacedDigit()).fixedSize()
                            }
                        } meta: {
                            HStack(spacing: 4) {
                                ForEach(Array(["#" + String(row.number), row.author?.login, model.checkCounts[row.id] ?? row.status].compactMap { $0 }.enumerated()), id: \.offset) { index, part in
                                    if index > 0 { Text("·") }
                                    Text(part).monospacedDigit().lineLimit(1)
                                }
                            }
                            Spacer(minLength: 4)
                            if let age = shortAge(row.updatedAt) { Text(age + " ago").monospacedDigit().fixedSize() }
                        }
                    }.buttonStyle(.plain).accessibilityIdentifier("pr.row.\(row.repository).\(row.number)")
                    .padding(.top, row.id == selected.first?.id ? 4 : 0)
                    .task(id: model.rowsGeneration) { [generation = model.rowsGeneration] in
                        guard model.checkCounts[row.id] == nil else { return }
                        struct Checks: Decodable { let checks: [PullRequestRecord.Detail.Check] }
                        guard let result = try? await store.pullRequest(.checks, input: row.ref, as: Checks?.self),
                              !Task.isCancelled, generation == model.rowsGeneration else { return }
                        let runs = result.checks.filter { $0.placeholder != true }
                        if !runs.isEmpty {
                            model.checkCounts[row.id] = "\(runs.filter { $0.status == "success" }.count) of \(runs.count) passed"
                        }
                    }
                }
            }
        }
        .background(theme.background)
        .refreshable { await model.load(store: store) }
    }

    /// The lab's `dotStates`: draft and plain open grey, running blue, passed green, failed amber.
    private func statusDot(_ row: PullRequestRow) -> StatusDotState {
        if row.isDraft { return .waiting }
        switch row.checksState {
        case "pending": return .working
        case "failing": return .limited
        case "passing": return .done
        default: return .waiting
        }
    }
}

@MainActor
@Observable
final class WorkspacePullRequests {
    var rows: [PullRequestRow] = []
    var checkCounts: [String: String] = [:]
    fileprivate var stats: [String: PullRequestStats.Stat] = [:]
    private(set) var rowsGeneration = UUID()
    private var request = UUID()
    var notice: String?
    var loading = true
    var filter = "All"

    func candidates(query: String) -> [PullRequestRow] {
        rows.filter { row in
            query.isEmpty || [row.title, row.repository, row.projectTitle, "#\(row.number)", row.headBranch, row.author?.login ?? "", row.labels?.map(\.name).joined(separator: " ") ?? ""]
                .joined(separator: " ").localizedCaseInsensitiveContains(query)
        }
    }

    func selected(query: String) -> [PullRequestRow] {
        candidates(query: query).filter { filter == "All" || $0.status == filter }
    }

    func load(store: CoreStore) async {
        let generation = UUID()
        request = generation
        loading = true
        defer { if request == generation && !Task.isCancelled { loading = false } }
        do {
            var input: [String: Any] = ["state": "open"]
            var result: [PullRequestRow] = []
            var seen = Set<String>()
            var messages = Set<String>()
            var previous = Set<[String: String]>()
            while true {
                let page = try await store.pullRequest(.list, input: input, as: PullRequestPage.self)
                try Task.checkCancellation()
                guard request == generation else { return }
                result += page.entries.filter { seen.insert($0.id).inserted }
                for error in page.errors { messages.insert("\(error.projectTitle): \(error.message)") }
                guard page.truncated else { break }
                guard !page.nextCursors.isEmpty, previous.insert(page.nextCursors).inserted else {
                    messages.insert("Showing a partial list.")
                    break
                }
                input["cursors"] = page.nextCursors
            }
            checkCounts = [:]
            rows = result
            rowsGeneration = generation
            notice = messages.isEmpty ? nil : messages.sorted().joined(separator: "\n")
            loading = false
            stats = [:]
            for start in stride(from: 0, to: result.count, by: 100) {
                let batch = result[start..<min(start + 100, result.count)]
                guard let response = try? await store.pullRequest(.listStats, input: ["refs": batch.map(\.ref)], as: PullRequestStats.self) else { break }
                guard request == generation && !Task.isCancelled else { return }
                for stat in response.stats {
                    if let row = batch.first(where: { $0.projectId == stat.projectId && $0.repository == stat.repository && $0.number == stat.number }) {
                        stats[row.id] = stat
                    }
                }
            }
        } catch {
            if request == generation && !Task.isCancelled { notice = error.localizedDescription }
        }
    }
}

/// The list's status filter, behind the header's 44pt glass button.
struct PullRequestFilterMenu: View {
    @Bindable var model: WorkspacePullRequests
    let searchQuery: String

    var body: some View {
        let candidates = model.candidates(query: searchQuery)
        Menu {
            Picker("Status", selection: $model.filter) {
                ForEach(["All", "Checks running", "Checks passed", "Checks failed", "Draft"], id: \.self) { option in
                    let label = option == "Checks running" ? "In progress" : option
                    Text("\(label) · \(candidates.filter { option == "All" || $0.status == option }.count)").tag(option)
                }
            }.pickerStyle(.inline)
        } label: { WorkspaceFilterIcon() }
        .accessibilityLabel("Filter pull requests")
    }
}

struct PullRequestRecord: View {
    struct Detail: Decodable {
        struct Check: Decodable {
            let name, status: String
            let description: String?
            let placeholder: Bool?
            let startedAt, completedAt: String?

            var duration: String? { threadElapsed(startedAt, completedAt) }

            var indicator: RecordStatus {
                switch status {
                case "success": .passed
                case "failure": .failed
                case "pending": threadDate(startedAt) == nil ? .queued : .running
                default: .queued
                }
            }

            var stateLabel: String {
                switch status {
                case "success": "Passed"
                case "failure": "Failed"
                case "pending": threadDate(startedAt) == nil ? "Queued" : "Running"
                default: status.replacingOccurrences(of: "-", with: " ").capitalized
                }
            }
        }
        struct Permissions: Decodable { let verdicts: [String]; let comment: Bool?; let inlineComment: Bool? }
        struct Capabilities: Decodable { let review: Permissions; let diff: Bool }
        let title, body: String
        let additions, deletions, changedFiles: Int
        let checks: [Check]
        let viewerPermissions: Permissions
        let capabilities: Capabilities
    }
    struct Activity: Decodable {
        struct Comment: Decodable { let id, body, createdAt: String }
        struct Commit: Decodable { let oid, messageHeadline, committedDate: String }
        struct Thread: Decodable {
            let path, side: String?
            let line: UInt32?
            let isOutdated: Bool
            let comments: [Comment]
        }
        let comments: [Comment]
        let reviewThreads: [Thread]
        let overviewThreads: [Thread]?
        let commits: [Commit]
    }
    struct DiffPage: Decodable {
        struct Omitted: Decodable { let path: String }
        let patch: String
        let nextCursor: String?
        let truncated: Bool
        let omittedFileStats: [Omitted]?
        let withheldFilesReadable: Bool?
    }
    @Environment(\.connTheme) private var theme
    let store: CoreStore
    let row: PullRequestRow
    @State private var section = "Overview"
    @State private var detail: Detail?
    @State private var activity: Activity?
    @State private var failure: String?
    @State private var checkFilter = "All"
    @State private var attempt = 0
    @State private var review: String?
    @State private var bodyText = ""
    struct FileChange: Identifiable {
        var id: String { patch.path }
        let patch: FfiFilePatch
        let additions: Int
        let deletions: Int

        var kind: String {
            if patch.oldPath == nil || patch.oldPath == "/dev/null" { return "New" }
            if patch.newPath == nil || patch.newPath == "/dev/null" { return "Deleted" }
            return "Edited"
        }

        init(_ patch: FfiFilePatch) {
            self.patch = patch
            additions = patch.lines.count { $0.marker == "+" }
            deletions = patch.lines.count { $0.marker == "-" }
        }
    }
    @State private var patches: [FileChange]?
    @State private var selectedFile: FileChange?
    @State private var omitted: [String] = []
    @State private var canReadOmitted = false
    @State private var truncated = false
    @State private var submitting = false

    @State private var fileFilter = "Changed"

    private var checks: [Detail.Check] { detail?.checks.filter { $0.placeholder != true } ?? [] }
    private var visibleChecks: [Detail.Check] { checks.filter { checkFilter == "All" || $0.stateLabel == checkFilter } }
    private var subtitle: String? {
        switch section {
        case "Checks":
            return "\(checkFilter == "All" ? checks.filter { $0.status == "success" }.count : visibleChecks.count) of \(checks.count) checks \(checkFilter == "All" ? "passed" : checkFilter.lowercased())"
        case "Timeline": return shortAge(row.updatedAt).map { "Updated " + $0 + " ago" }
        case "Code":
            if let patches {
                let count = patches.filter { fileFilter == "Changed" || $0.kind == fileFilter }.count
                return "\(count) \(fileFilter.lowercased()) \(count == 1 ? "file" : "files")"
            }
            return detail.map { "\($0.changedFiles) changed \($0.changedFiles == 1 ? "file" : "files")" }
        default: return nil
        }
    }
    private var canCommentOnFile: Bool {
        detail?.capabilities.review.inlineComment == true &&
        detail?.viewerPermissions.comment == true &&
        detail?.capabilities.review.verdicts.contains("comment") == true &&
        detail?.viewerPermissions.verdicts.contains("comment") == true
    }

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 0) {
                if let failure { Text(failure); Button("Try again") { attempt += 1 } }
                if let detail {
                    switch section {
                    case "Checks":
                        ForEach(Array(visibleChecks.enumerated()), id: \.offset) { index, check in
                            HStack(spacing: 8) {
                                RecordStatusIndicator(status: check.indicator, failedColor: theme.warning)
                                Text(check.name)
                                Spacer(minLength: 8)
                                Text(check.indicator == .queued ? "—" : check.duration ?? "")
                                    .font(.system(size: 13)).monospacedDigit().foregroundStyle(theme.mutedForeground)
                            }
                            .frame(minHeight: 22).padding(.top, index == 0 ? 0 : 12).padding(.bottom, 12)
                            .overlay(alignment: .bottom) {
                                if index + 1 < visibleChecks.count { Rectangle().fill(theme.border).frame(height: 1) }
                            }
                            .accessibilityElement(children: .combine).accessibilityValue(check.stateLabel)
                        }
                    case "Code":
                        if let patches {
                            ForEach(Array(patches.filter { fileFilter == "Changed" || $0.kind == fileFilter }.enumerated()), id: \.element.patch.path) { index, change in
                                let path = change.patch.path as NSString
                                Button {
                                    selectedFile = change
                                } label: {
                                    HStack(alignment: .top, spacing: 8) {
                                        ChangedFileIcon(path: change.patch.path).frame(height: 21)
                                        VStack(alignment: .leading, spacing: 4) {
                                            HStack(alignment: .firstTextBaseline, spacing: 8) {
                                                Text(path.lastPathComponent)
                                                    .font(.system(size: 16, weight: .medium))
                                                    .frame(maxWidth: .infinity, minHeight: 21, alignment: .leading)
                                                FileLineStats(additions: change.additions, deletions: change.deletions)
                                            }
                                            if !path.deletingLastPathComponent.isEmpty {
                                                Text(path.deletingLastPathComponent)
                                                    .font(.system(size: 13)).foregroundStyle(theme.mutedForeground)
                                                    .frame(minHeight: 17)
                                            }
                                        }
                                    }
                                    .lineLimit(1)
                                    .padding(.top, index == 0 ? 0 : 10).padding(.bottom, 10)
                                    .frame(minHeight: 48, alignment: .top)
                                    .contentShape(Rectangle())
                                }.buttonStyle(.plain).accessibilityIdentifier("pr.file.\(change.patch.path)")
                            }
                            ForEach(omitted, id: \.self) { path in
                                if canReadOmitted {
                                    NavigationLink(path) { OmittedPatch(store: store, row: row, path: path, canComment: canCommentOnFile) }
                                } else { LabeledContent(path, value: "Diff unavailable") }
                            }
                            if truncated { Text("Some changes were omitted by the host.").foregroundStyle(theme.mutedForeground) }
                            if patches.isEmpty && omitted.isEmpty && !truncated { Text("No changed files").foregroundStyle(theme.mutedForeground) }
                        } else if failure == nil { ProgressView() }
                    case "Timeline":
                        if let activity {
                            let comments = activity.comments + (activity.reviewThreads + (activity.overviewThreads ?? [])).flatMap(\.comments)
                            let commits = Set(activity.commits.map(\.oid))
                            let events = Dictionary(grouping: comments, by: \.id).values.compactMap(\.first).map { ($0.createdAt, $0.id, $0.body) }
                                + activity.commits.map { ($0.committedDate, $0.oid, $0.messageHeadline) }
                            let sorted = events.sorted { $0.0 < $1.0 }
                            VStack(alignment: .leading, spacing: 0) {
                                TimelineEvent(icon: "pull-request", last: false) {
                                    Text("\(Text(row.author?.login ?? "Someone").bold()) opened \(row.isDraft ? "a draft pull request" : "the pull request").")
                                }
                                .accessibilityElement(children: .combine).accessibilityIdentifier("pr.timeline.opened")
                                ForEach(sorted, id: \.1) { event in
                                    TimelineEvent(icon: commits.contains(event.1) ? "branch" : "comment-text", last: false) {
                                        MarkdownView(source: event.2, recordStyle: true)
                                        if let age = shortAge(event.0) { TimelineAge(text: age + " ago") }
                                    }
                                    .accessibilityElement(children: .combine).accessibilityIdentifier("pr.timeline.event")
                                }
                                TimelineEvent(icon: "clock", last: true) {
                                    Text(row.status).bold()
                                    if let age = shortAge(row.updatedAt) { TimelineAge(text: age + " ago") }
                                }
                            }
                        } else if failure == nil { ProgressView() }
                    default:
                        RecordHeading(title: row.title) {
                            RecordField(icon: "folder", label: "Repository", value: row.repository)
                            if let author = row.author { RecordField(icon: "users", label: "Author", value: [author.login, shortAge(row.updatedAt).map { $0 + " ago" }].compactMap { $0 }.joined(separator: " · ")) }
                            RecordField(icon: "branch", label: "Branch", value: "\(row.headBranch) → \(row.baseBranch)")
                            RecordFieldRow(icon: "trend-up", label: "Changes") {
                                RecordLineStats(added: Double(detail.additions), removed: Double(detail.deletions))
                            }
                        }
                        MarkdownView(source: detail.body, recordStyle: true)
                            .padding(.top, 13)
                        let verdicts = detail.viewerPermissions.verdicts.filter { detail.capabilities.review.verdicts.contains($0) }
                        if !verdicts.isEmpty {
                            Menu("Review") {
                                ForEach(verdicts, id: \.self) { verdict in
                                    Button(verdict.replacingOccurrences(of: "-", with: " ").capitalized) { review = verdict }
                                }
                            }.disabled(submitting)
                        }
                    }
                } else if failure == nil { ProgressView() }
            }
            .font(.system(size: 14))
            .foregroundStyle(theme.foreground)
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(.horizontal, 20).padding(.top, 28).padding(.bottom, 100)
        }
        .background(theme.background)
        .modifier(RecordChrome(title: section == "Overview" ? "Pull request #\(row.number)" : section,
                               subtitle: subtitle,
                               tabs: [("Overview", "file-text"), ("Checks", "check-circle"), ("Timeline", "clock")]
                                  + (detail?.capabilities.diff == true ? [("Code", "code")] : []),
                               selection: section) { section = $0 })
        .toolbar {
            if section == "Checks" || (section == "Code" && Set(patches?.map(\.kind) ?? []).count > 1) {
                ToolbarItem(placement: .topBarTrailing) {
                    Menu {
                        if section == "Checks" {
                            Picker("Filter checks", selection: $checkFilter) {
                                ForEach(["All"] + Set(checks.map(\.stateLabel)).sorted(), id: \.self) { key in
                                    Text("\(key) · \(checks.filter { key == "All" || $0.stateLabel == key }.count)").tag(key)
                                }
                            }
                        } else {
                            Picker("Filter files", selection: $fileFilter) {
                                ForEach(["Changed"] + Set(patches?.map(\.kind) ?? []).sorted(), id: \.self) { key in
                                    Text("\(key) · \(patches?.filter { key == "Changed" || $0.kind == key }.count ?? 0)").tag(key)
                                }
                            }
                        }
                    } label: { WorkspaceFilterIcon() }
                    .accessibilityLabel(section == "Checks" ? "Filter checks" : "Filter files")
                }.sharedBackgroundVisibility(.hidden)
            }
        }
        .navigationDestination(isPresented: Binding(get: { selectedFile != nil }, set: { if !$0 { selectedFile = nil } })) {
            if let file = selectedFile {
                ReviewFileView(store: store, row: row, file: file, canComment: canCommentOnFile)
            }
        }
        .alert("Submit review", isPresented: Binding(get: { review != nil }, set: { if !$0 { review = nil } })) {
            TextField("Comment", text: $bodyText)
            Button("Cancel", role: .cancel) {}
            Button("Submit") {
                guard let verdict = review else { return }
                submitting = true
                Task {
                    defer { submitting = false }
                    do {
                        typealias Result = Bool?
                        var input = row.ref
                        input["verdict"] = verdict
                        input["body"] = bodyText
                        input["comments"] = [String]()
                        _ = try await store.pullRequest(.submitReview, input: input, as: Result.self)
                        bodyText = ""
                        attempt += 1
                    } catch { failure = error.localizedDescription }
                }
            }
        }
        .task(id: "\(section)-\(attempt)") {
            failure = nil
            do {
                if detail == nil || section == "Overview" {
                    detail = try await store.pullRequest(.detail, input: row.ref, as: Detail.self)
                }
                if section == "Code" && patches == nil {
                    var input = row.ref
                    var result: [FfiFilePatch] = []
                    var paths = Set<String>()
                    var incomplete = false
                    var cursors = Set<String>()
                    repeat {
                        let page = try await store.pullRequest(.diff, input: input, as: DiffPage.self)
                        try Task.checkCancellation()
                        result += await Task.detached { parseFilePatches(patch: page.patch) }.value
                        paths.formUnion(page.omittedFileStats?.map(\.path) ?? [])
                        if let readable = page.withheldFilesReadable { canReadOmitted = readable }
                        incomplete = incomplete || page.truncated
                        guard let cursor = page.nextCursor, cursors.insert(cursor).inserted else { break }
                        input["cursor"] = cursor
                    } while true
                    omitted = paths.subtracting(result.map(\.path)).sorted()
                    truncated = incomplete
                    patches = await Task.detached { [result] in result.map(FileChange.init) }.value
                }
                if section == "Timeline" {
                    activity = try await store.pullRequest(.activity, input: row.ref, as: Activity.self)
                }
            } catch { if !Task.isCancelled { failure = error.localizedDescription } }
        }
    }
}

private struct ReviewFileView: View {
    let store: CoreStore
    let row: PullRequestRow
    let file: PullRequestRecord.FileChange
    let canComment: Bool
    @State private var line: FfiPatchLine?
    @State private var draft = ""
    @State private var sending = false
    @State private var comments: [String: [String]] = [:]
    @State private var revision = 0
    @State private var error: String?

    var body: some View {
        ScrollView {
            VStack(alignment: .leading) {
                if let error, line == nil { Text(error).foregroundStyle(.secondary) }
                PatchBody(patch: file.patch, comments: comments, comment: canComment && store.status == .connected ? { line = $0 } : nil)
            }
        }
        .task(id: revision) {
            do {
                let activity = try await store.pullRequest(.activity, input: row.ref, as: PullRequestRecord.Activity.self)
                var anchored: [String: [String]] = [:]
                for thread in activity.reviewThreads where !thread.isOutdated {
                    guard let line = thread.line, let side = thread.side,
                          thread.path == (file.patch.newPath ?? file.patch.oldPath) || (side == "left" && thread.path == file.patch.oldPath) else { continue }
                    anchored[side + String(line), default: []] += thread.comments.map(\.body)
                }
                comments = anchored
            } catch { if !Task.isCancelled { self.error = error.localizedDescription } }
        }
        .navigationTitle((file.patch.path as NSString).lastPathComponent)
        .toolbar(.hidden, for: .bottomBar)
        .toolbar {
            ToolbarItem(placement: .principal) {
                VStack(spacing: 0) {
                    Text((file.patch.path as NSString).lastPathComponent).font(.system(size: 17, weight: .semibold)).lineLimit(1)
                    FileLineStats(additions: file.additions, deletions: file.deletions).font(.system(size: 12))
                }
            }
        }
        .safeAreaInset(edge: .bottom) {
            if store.showsOffline { OfflinePill(store: store).padding(.bottom, 8) }
        }
        .sheet(isPresented: Binding(get: { line != nil }, set: { if !$0 { line = nil } })) {
            NavigationStack {
                Form {
                    TextField("Comment", text: $draft, axis: .vertical)
                    if let error { Text(error).foregroundStyle(.red) }
                }
                .navigationTitle("Comment on line " + String(line?.number ?? 0))
                .navigationBarTitleDisplayMode(.inline)
                .toolbar {
                    ToolbarItem(placement: .cancellationAction) {
                        Button("Cancel") { line = nil; draft = ""; error = nil }.disabled(sending)
                    }
                    ToolbarItem(placement: .confirmationAction) {
                        Button("Submit") { Task { await submit() } }
                            .disabled(sending || draft.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
                    }
                }
            }.interactiveDismissDisabled(!draft.isEmpty || sending)
        }
    }

    private func submit() async {
        guard !sending, let line else { return }
        let position: [String: Any]
        switch (line.oldLine, line.newLine) {
        case let (old?, new?): position = ["kind": "context", "oldLine": old, "newLine": new, "side": "right"]
        case let (nil, new?): position = ["kind": "added", "newLine": new]
        case let (old?, nil): position = ["kind": "deleted", "oldLine": old]
        case (nil, nil): return
        }
        guard let path = file.patch.newPath ?? file.patch.oldPath else { return }
        var comment: [String: Any] = ["path": path, "position": position, "body": draft]
        if let old = file.patch.oldPath, old != path { comment["oldPath"] = old }
        var input = row.ref
        input["verdict"] = "comment"
        input["body"] = ""
        input["comments"] = [comment]
        sending = true
        defer { sending = false }
        do {
            _ = try await store.pullRequest(.submitReview, input: input, as: Bool?.self)
            revision += 1
            self.line = nil
            draft = ""
            error = nil
        } catch { self.error = error.localizedDescription }
    }
}

private struct OmittedPatch: View {
    let store: CoreStore
    let row: PullRequestRow
    let path: String
    let canComment: Bool
    @State private var change: PullRequestRecord.FileChange?
    @State private var error: String?

    var body: some View {
        Group {
            if let change { ReviewFileView(store: store, row: row, file: change, canComment: canComment) }
            else if let error { Text(error) }
            else { ProgressView() }
        }
        .navigationTitle(path)
        .toolbar(.hidden, for: .bottomBar)
        .task {
            do {
                var input = row.ref
                input["path"] = path
                let page = try await store.pullRequest(.diff, input: input, as: PullRequestRecord.DiffPage.self)
                change = await Task.detached { parseFilePatches(patch: page.patch).first.map(PullRequestRecord.FileChange.init) }.value
                if change == nil { error = "No diff available" }
            } catch { self.error = error.localizedDescription }
        }
    }
}

/// `FileStats`: +additions and −deletions 5pt apart, each hidden at zero; 14pt unless set.
private struct FileLineStats: View {
    let additions: Int
    let deletions: Int
    @Environment(\.connTheme) private var theme
    @Environment(\.colorScheme) private var colorScheme

    var body: some View {
        HStack(spacing: 5) {
            if additions > 0 { Text("+\(additions)").foregroundStyle(AdaptiveColor.emerald700300.color(colorScheme)) }
            if deletions > 0 { Text("−\(deletions)").foregroundStyle(theme.destructive) }
        }
        .font(.system(size: 14))
        .monospacedDigit()
        .fixedSize()
    }
}

/// One `ios-pr-timeline` item: a 16pt muted glyph (2pt down), 12pt gap, 22pt below, and a 1pt
/// line from under the glyph to the next item.
private struct TimelineEvent<Content: View>: View {
    let icon: String
    let last: Bool
    @ViewBuilder let content: Content
    @Environment(\.connTheme) private var theme

    var body: some View {
        HStack(alignment: .top, spacing: 12) {
            ThreadGlyph(name: icon, size: 16)
                .foregroundStyle(theme.mutedForeground)
                .padding(.top, 2)
            VStack(alignment: .leading, spacing: 0) { content }
                .lineHeight(.exact(points: RecordRow.lineHeight))
                .frame(maxWidth: .infinity, alignment: .leading)
        }
        .padding(.bottom, 22)
        .overlay(alignment: .topLeading) {
            if !last {
                Rectangle().fill(theme.border).frame(width: 1)
                    .padding(.top, 22).padding(.bottom, 3).padding(.leading, 7)
            }
        }
    }
}

private struct TimelineAge: View {
    let text: String
    @Environment(\.connTheme) private var theme

    var body: some View {
        Text(text).font(.system(size: 11.67)).foregroundStyle(theme.mutedForeground)
    }
}

private func shortAge(_ timestamp: String?) -> String? {
    guard let date = threadDate(timestamp) else { return nil }
    let seconds = max(0, Int(-date.timeIntervalSinceNow))
    if seconds < 60 { return "\(seconds)s" }
    if seconds < 3600 { return "\(seconds / 60)m" }
    if seconds < 86400 { return "\(seconds / 3600)h" }
    return "\(seconds / 86400)d"
}

private struct ChangedFileIcon: View {
    let path: String
    @Environment(\.colorScheme) private var scheme
    @Environment(\.connTheme) private var theme

    var body: some View {
        let ext = (path as NSString).pathExtension.lowercased()
        let icon: (String, UInt32, UInt32)? = switch ext {
        case "php": ("php", 0x693acf, 0x9d6afb)
        case "vue": ("vue", 0x199f43, 0x5ecc71)
        case "ts", "mts", "cts": ("typescript", 0x1a85d4, 0x69b1ff)
        case "tsx", "jsx": ("react", 0x1ca1c7, 0x68cdf2)
        case "js", "cjs", "mjs": ("javascript", 0xd5a910, 0xffd452)
        case "json", "swift", "html": (ext, 0xd47628, 0xffa359)
        case "rs": ("rust", 0xd47628, 0xffa359)
        case "md": ("markdown", 0x199f43, 0x5ecc71)
        case "py": ("python", 0x1a85d4, 0x69b1ff)
        case "css": ("css", 0x693acf, 0x9d6afb)
        default: nil
        }
        Group {
            if let icon {
                Image("file-" + icon.0).resizable().scaledToFit()
                    .foregroundStyle(Color(rgbHex: scheme == .dark ? icon.2 : icon.1))
            } else { ThreadGlyph(name: "file-text", size: 18).foregroundStyle(theme.mutedForeground) }
        }.frame(width: 18, height: 18).accessibilityHidden(true)
    }
}
