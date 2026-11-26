import DesignKit
import SwiftUI
import UIKit

struct ThreadView: View {
    @Bindable var store: CoreStore
    let threadId: String
    let initialTitle: String
    let initialProjectTitle: String?
    let initialBranch: String?
    let initialSettled: Bool
    let onOpenThread: (String, String?) -> Void
    let onTemplate: (String) -> Void
    @State private var setup: FfiWorktreeSetup?

    @Environment(\.connTheme) private var theme
    @Environment(\.dismiss) private var dismiss
    @State private var readingWindow: FfiThreadSnapshot?
    @State private var markers: [FfiPromptMarker] = []
    @State private var outlineQuery = ""
    @State private var showsOutline = false
    @ScaledMetric(relativeTo: .body) private var feedTextSize: CGFloat = ThreadText.size
    /// The paragraph gap below a fold row, less the feed spacing the stack already adds.
    private var foldGap: CGFloat { feedTextSize * 0.85 - ThreadFeed.spacing }
    /// The last feed shown, kept while another thread covers this one.
    @State private var retainedSnapshot: FfiThreadSnapshot?
    private static let titleInset: CGFloat = 16 + 44 + 16
    @State private var showsAgents = false
    /// The feed's scroll state (pinned, jump button), owned by the feed controller.
    @State private var chrome = FeedChrome()
    @State private var historyNotice: String?
    @State private var scrollRequest: FeedScrollRequest?
    @State private var historyRequest = UUID()
    @State private var paging = false
    @State private var pageExhausted = false
    /// When this thread opened, for the first-frame log.
    @State private var openedAt = Date.distantPast
    /// The open whose first frame was logged (`logFirstFrame`); a class, so body may set it.
    @State private var frameLogged = FrameLog()
    @State private var settled: Bool
    @State private var showingRename = false
    @State private var renameDraft = ""
    @State private var viewSize: CGSize = .zero

    /// The draft object only: its text is read by `ThreadComposerArea`, so typing leaves this body.
    private var composer: ComposerDraft { store.composerDraft(.thread(threadId)) }

    /// The chip's provider and the sheet; `model_picker` in conn-ffi builds both.
    @State private var modelPicker: FfiModelPicker?
    @State private var showingModelPicker = false

    init(
        store: CoreStore,
        threadId: String,
        initialTitle: String,
        initialProjectTitle: String?,
        initialBranch: String?,
        initialSettled: Bool,
        onOpenThread: @escaping (String, String?) -> Void,
        onTemplate: @escaping (String) -> Void
    ) {
        self.store = store
        self.threadId = threadId
        self.initialTitle = initialTitle
        self.initialProjectTitle = initialProjectTitle
        self.initialBranch = initialBranch
        self.initialSettled = initialSettled
        self.onOpenThread = onOpenThread
        self.onTemplate = onTemplate
        self._settled = State(initialValue: initialSettled)
        // Start at the screen size, so the first frame of a push already lays the title out
        // between the buttons instead of full width (the geometry arrives a frame later).
        let screen = (UIApplication.shared.connectedScenes.first as? UIWindowScene)?.screen.bounds.size
        self._viewSize = State(initialValue: screen ?? .zero)
    }

    private var snapshot: FfiThreadSnapshot? {
        if let readingWindow, readingWindow.threadId == threadId { return readingWindow }
        if let current = store.openThread, current.threadId == threadId { return current }
        // Covered by a thread opened from a link: keep the feed, so Back returns to the same spot.
        return retainedSnapshot?.threadId == threadId ? retainedSnapshot : nil
    }

    private var pendingApprovals: [FfiPendingApproval] {
        readingWindow == nil && store.status == .connected ? snapshot?.pendingApprovals ?? [] : []
    }
    private var pendingQuestion: FfiPendingQuestion? {
        readingWindow == nil && pendingApprovals.isEmpty && store.status == .connected ? snapshot?.pendingQuestion : nil
    }


    private var displayTitle: String {
        if let title = snapshot?.title, !title.isEmpty { return title }
        return initialTitle.isEmpty ? "Thread" : initialTitle
    }

    private var displaySubtitle: String? {
        var parts: [String] = []
        if let project = initialProjectTitle, !project.isEmpty {
            parts.append(project)
        }
        let branch = snapshot?.branch ?? initialBranch
        if let branch, !branch.isEmpty {
            parts.append(branch)
        }
        return parts.isEmpty ? nil : parts.joined(separator: " · ")
    }

    private var canReadEarlier: Bool {
        guard let snapshot, store.offlineReader != nil, !snapshot.entries.isEmpty, !pageExhausted else { return false }
        return readingWindow != nil || !snapshot.synchronized || snapshot.historyCursor != nil
    }

    private var isWorking: Bool {
        snapshot?.working == true
    }

    private func latest() {
        historyRequest = UUID()
        paging = false
        pageExhausted = false
        readingWindow = nil
        historyNotice = nil
        scrollRequest = FeedScrollRequest(target: .end)
    }

    private func readHistory(prompt: String? = nil) {
        guard let reader = store.offlineReader, var current = snapshot else { return }
        if prompt == nil && (paging || !canReadEarlier) { return }
        let request = UUID()
        historyRequest = request
        paging = true
        let online = store.status == .connected
        Task {
            defer { if request == historyRequest { paging = false } }
            do {
                if let prompt {
                    let window = try await reader.promptWindow(thread: threadId, id: prompt, online: online)
                    guard request == historyRequest, store.offlineReader === reader,
                          store.openThreadId == threadId else { return }
                    pageExhausted = window.serverPage && window.historyCursor == nil
                    readingWindow = window
                    scrollRequest = FeedScrollRequest(target: .item("e:" + prompt))
                } else {
                    guard let first = current.entries.first(where: {
                        switch $0 { case .user, .assistant: true; default: false }
                    })?.entryId ?? current.entries.first?.entryId else { return }
                    var older: [FfiTimelineEntry] = []
                    if !current.serverPage {
                        let page = try await reader.before(thread: threadId, id: first)
                        older = page.entries
                        current.feedDetails.merge(page.feedDetails) { current, _ in current }
                        current.delegatedTaskIds.merge(page.delegatedTaskIds) { current, _ in current }
                    }
                    if older.isEmpty {
                        guard online else {
                            if request == historyRequest { historyNotice = "Reconnect to load earlier messages." }
                            return
                        }
                        var visited = Set<String>()
                        repeat {
                            guard request == historyRequest, store.offlineReader === reader,
                                  store.openThreadId == threadId else { return }
                            if current.serverPage && current.historyCursor == nil { break }
                            let atLiveBoundary = store.openThread?.entries.first?.entryId == first
                            let cursor = current.serverPage ? current.historyCursor
                                : (atLiveBoundary ? store.openThread?.historyCursor : nil)
                            if let cursor, !visited.insert(cursor).inserted { break }
                            let page = try await reader.serverBefore(
                                thread: threadId, anchor: first, continuation: cursor,
                                snapshotCursor: store.openThread?.historyCursor
                            )
                            older = page.entries
                            current.serverPage = true
                            current.historyCursor = page.historyCursor
                            current.feedDetails.merge(page.feedDetails) { current, _ in current }
                            current.delegatedTaskIds.merge(page.delegatedTaskIds) { current, _ in current }
                            current.workGroups.insert(contentsOf: page.workGroups, at: 0)
                        } while older.isEmpty
                    }
                    guard request == historyRequest, store.offlineReader === reader,
                          store.openThreadId == threadId else { return }
                    var ids = Set(current.entries.map(\.entryId))
                    current.entries.insert(contentsOf: older.filter { ids.insert($0.entryId).inserted }, at: 0)
                    current.removeRepeatedDelegatedResults()
                    pageExhausted = current.serverPage && current.historyCursor == nil
                    guard !older.isEmpty else {
                        historyNotice = nil
                        return
                    }
                    // The feed keeps the first visible row in place as the older rows land above it.
                    readingWindow = current
                }
                historyNotice = nil
            } catch {
                guard request == historyRequest else { return }
                historyNotice = error.localizedDescription
            }
        }
    }

    private func loadOutline() async {
        guard let reader = store.offlineReader else { return }
        do {
            let result = try await reader.outline(thread: threadId, online: store.status == .connected)
            if !Task.isCancelled { markers = result }
        } catch {
            if !Task.isCancelled { historyNotice = error.localizedDescription }
        }
    }

    var body: some View {
        let _ = BodyCount.tick("ThreadView")
        // The feed runs under the header and composer, and iOS's soft scroll edge blurs it there,
        // as Conn mobile's EdgeBlur does. It handles the keyboard itself.
        ThreadFeedHost(
            threadId: threadId,
            rows: feedRows,
            // The stack gap and 1 pt end marker under the last row; over a capsule, 10 less.
            bottomPadding: capsuleShown ? ThreadFeed.spacing - 8 : ThreadFeed.spacing + 2,
            capsuleInset: capsuleShown ? Self.floatingRowHeight : 0,
            forceJump: readingWindow != nil,
            hasContent: snapshot != nil,
            scrollRequest: scrollRequest,
            chrome: chrome,
            composer: AnyView(composerArea),
            floating: AnyView(floatingControl),
            onReachTop: { readHistory() }
        )
        .ignoresSafeArea()
        .background(theme.background.ignoresSafeArea())
        .navigationTitle(displayTitle)
        .navigationBarTitleDisplayMode(.inline)
        .navigationBarBackButtonHidden()
        .background { ThreadEdgePopGesture() }
        .toolbar {
            ToolbarItem(placement: .topBarLeading) {
                Button { dismiss() } label: {
                    ThreadGlyph(name: "chevron-left", size: 22)
                        .flipsForRightToLeftLayoutDirection(true)
                        .foregroundStyle(theme.foreground)
                        .frame(width: 44, height: 44)
                        .glassEffect(.regular.interactive(), in: .circle)
                }
                .accessibilityLabel("Back")
            }
            .sharedBackgroundVisibility(.hidden)
            ToolbarItem(placement: .principal) {
                VStack(spacing: 0) {
                    // Lab `.m-header-title-text`: 17/22 at 600; `.m-header-subtitle`: 12/16, muted.
                    Text(displayTitle).font(.system(size: 17, weight: .semibold)).lineHeight(.exact(points: 22))
                    if let displaySubtitle {
                        Text(displaySubtitle).font(.system(size: 12)).lineHeight(.exact(points: 16))
                            .foregroundStyle(theme.mutedForeground)
                    }
                }
                .lineLimit(1)
                .truncationMode(.tail)
                // 16 from the screen edge, the 44 pt button, then a clear 16 pt gap on each side.
                .frame(width: viewSize.width > Self.titleInset * 2 ? viewSize.width - Self.titleInset * 2 : nil)
                .foregroundStyle(theme.foreground)
                .accessibilityElement(children: .combine)
                .accessibilityAddTraits(.isHeader)
            }
            ToolbarItem(placement: .topBarTrailing) {
                Menu {
                    Button { showsOutline = true } label: { Label("Thread outline", systemImage: "list.bullet") }
                } label: {
                    ThreadGlyph(name: "more-horizontal", size: 22)
                        .foregroundStyle(theme.foreground)
                        .frame(width: 44, height: 44)
                        .glassEffect(.regular.interactive(), in: .circle)
                }
                .accessibilityLabel("More actions")
                .accessibilityIdentifier("thread.moreButton")
            }
            .sharedBackgroundVisibility(.hidden)
        }
        .onGeometryChange(for: CGSize.self) { $0.size } action: { viewSize = $0 }
        .animation(.easeOut(duration: 0.2), value: snapshot?.pendingApprovals.first?.requestId)
        .animation(.easeOut(duration: 0.2), value: pendingQuestion?.requestId)
        .sheet(isPresented: $showsAgents) {
            ThreadAgentsSheet(agents: turnSubagents) { agent in
                guard let child = agent.child else { return }
                showsAgents = false
                onOpenThread(child, agent.environment)
            }
        }
        .sheet(isPresented: $showsOutline) {
            NavigationStack {
                List(markers.filter {
                    outlineQuery.isEmpty || $0.preview.localizedCaseInsensitiveContains(outlineQuery)
                        || ($0.assistantPreview?.localizedCaseInsensitiveContains(outlineQuery) ?? false)
                }, id: \.id) { marker in
                    Button {
                        showsOutline = false
                        readHistory(prompt: marker.id)
                    } label: {
                        VStack(alignment: .leading, spacing: 4) {
                            Text(marker.preview).lineLimit(2)
                            if let reply = marker.assistantPreview {
                                Text(reply).font(.caption).foregroundStyle(.secondary).lineLimit(2)
                            }
                            if marker.hasError { Label("Error", systemImage: "exclamationmark.triangle") }
                            if marker.hasCheckpoint { Label("Checkpoint", systemImage: "bookmark") }
                        }
                    }
                }
                .overlay { if markers.isEmpty { Text("No saved prompts").foregroundStyle(.secondary) } }
                .searchable(text: $outlineQuery, prompt: "Find a prompt")
                .navigationTitle("Thread outline")
                .toolbar { Button("Done") { showsOutline = false } }
                .task { await loadOutline() }
            }
        }
        .onChange(of: store.status) { _, status in
            if status == .connected { historyNotice = nil }
            if !chrome.pinned && readingWindow == nil {
                readingWindow = store.openThread
            }
        }
        .alert("Rename Thread", isPresented: $showingRename) {
            TextField("Title", text: $renameDraft)
            Button("Cancel", role: .cancel) {}
            Button("Save") {
                let newTitle = renameDraft
                Task {
                    await store.renameThread(threadId: threadId, title: newTitle)
                }
            }
        }
        .task(id: "\(threadId)|\(store.identityEpoch)|\(store.status == .connected)") {
            setup = nil
            guard store.status == .connected, let feed = try? store.setupFeed(thread: threadId) else { return }
            await withTaskCancellationHandler {
                do {
                    while !Task.isCancelled {
                        let next = try await feed.next()
                        try Task.checkCancellation()
                        setup = next
                    }
                } catch { }
            } onCancel: { feed.cancel() }
        }
        .task(id: threadId) {
            openedAt = Date()
            store.openThread(threadId)
        }
        .task(id: "\(threadId)|\(store.providersRevision)|\(snapshot?.modelLabel ?? "")") {
            modelPicker = await store.modelPicker(threadId: threadId)
        }
        .sheet(isPresented: $showingModelPicker) {
            ModelPickerSheet(store: store, threadId: threadId)
                .presentationDetents([.large])
        }
        .onDisappear {
            retainedSnapshot = snapshot
            historyRequest = UUID()
            store.closeThread(threadId)
        }
    }

    /// The feed's rows, in the SwiftUI stack's order and spacing: 36 between items (lab
    /// `.m-feed-inner`), a paragraph gap under a "Worked for" row, 8 between the user's own
    /// consecutive messages.
    private var feedRows: [FeedRow] {
        let _ = BodyCount.tick("ThreadView.feed")
        var rows: [FeedRow] = []
        let linkProject: @MainActor (String) -> String? = { [store] in store.linkProjectTitle(threadId: $0) }
        // Thread links in messages (`t3-thread://v2/…`, `conn://thread/…`) open in the app; other
        // links go to the system.
        let openURL = OpenURLAction { [onOpenThread] url in
            guard let link = ThreadLink(url: url) else { return .systemAction }
            onOpenThread(link.threadId, link.environmentId)
            return .handled
        }
        // What a row draws from, beyond its id: the feed re-measures and redraws a row only when
        // this changes, so updates elsewhere (a clock tick, another row streaming) leave it alone.
        let shellStamp = feedSignature(store.shell?.threads.count, store.identityEpoch, store.status == .connected)
        func add(_ id: String, extra: CGFloat = 0, key: Int = 0,
                 @ViewBuilder _ content: @escaping @MainActor () -> some View) {
            rows.append(FeedRow(id: id, gap: ThreadFeed.spacing + extra, signature: key) {
                AnyView(
                    content()
                        // Card edges line up with the composer's 12-point inset.
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .padding(.horizontal, 12)
                        .environment(\.threadLinkProject, linkProject)
                        .environment(\.openURL, openURL)
                )
            })
        }

        if let error = store.lastError, !error.isEmpty {
            add("notice:error", key: error.hashValue) { KitNotice(error, icon: .warning, tone: .error) }
        }
        guard let snapshot else {
            add("loading") { [theme] in
                HStack(spacing: Kit.Space.m) {
                    KitStatusIcon(.working, size: 16, label: "Loading")
                    Text("Loading timeline…")
                        .font(.kitDetail)
                        .foregroundStyle(theme.mutedForeground)
                }
                .frame(maxWidth: .infinity)
                .padding(.vertical, 48)
            }
            return rows
        }
        if canReadEarlier {
            let paging = paging
            add("earlier", key: paging.hashValue) {
                Button("Earlier messages") { readHistory() }
                    .disabled(paging)
                    .font(.kitDetail)
            }
        }
        if let setup, setup.threadId == threadId, readingWindow == nil {
            add("worktree", key: setup.hashValue) { ThreadWorktreeCard(setup: setup) }
        }
        if snapshot.entries.isEmpty {
            let text = store.status == .connected ? "No messages in this thread yet." : "No saved messages for this thread."
            add("empty", key: text.hashValue) { [theme] in
                Text(text)
                    .font(.kitDetail)
                    .foregroundStyle(theme.mutedForeground)
                    .frame(maxWidth: .infinity)
                    .padding(.vertical, 48)
            }
        } else {
            let _ = logFirstFrame(snapshot)
            let items = renderItems(for: snapshot)
            // What follows a "Worked for" row sits a paragraph gap below it, not the feed spacing.
            let afterFold = Set(zip(items, items.dropFirst()).compactMap { pair -> String? in
                if case .workGroup = pair.0 { return pair.1.id } else { return nil }
            })
            // A question or approval row is a work-log row: it hangs straight off the fold's
            // divider, its own padding the same above as below.
            let logRows = Set(items.compactMap { Self.isLogRow($0) ? $0.id : nil })
            // The user's messages sent one after another, with nothing between, sit close together
            // (`ThreadFeed.userRunSpacing`) and read as one group.
            let inUserRun = Set(zip(items, items.dropFirst()).compactMap { pair -> String? in
                Self.isUserMessage(pair.0) && Self.isUserMessage(pair.1) ? pair.1.id : nil
            })
            let interactive = readingWindow == nil && store.status == .connected
            for item in items {
                let extra = afterFold.contains(item.id) && logRows.contains(item.id) ? -ThreadFeed.spacing
                    : afterFold.contains(item.id) ? foldGap
                    : inUserRun.contains(item.id) ? ThreadFeed.userRunSpacing - ThreadFeed.spacing : 0
                switch item {
                case let .workGroup(group, entries):
                    let start = snapshot.activeWorkStartedAtMs
                    let offset = snapshot.serverClockOffsetMs
                    add(item.id, extra: extra, key: feedSignature(group, entries, start, offset)) {
                        WorkGroupCard(group: group, entries: entries, workStartedAtMs: start, clockOffsetMs: offset)
                            .equatable()
                    }
                case let .entry(entry):
                    let detail = snapshot.feedDetails[entry.entryId]
                    add(item.id, extra: extra, key: feedSignature(entry, detail, interactive, shellStamp)) {
                        [store, threadId, onOpenThread, onTemplate] in
                        TimelineEntryRow(
                            threadId: threadId,
                            entry: entry,
                            store: store,
                            detail: detail,
                            interactive: interactive,
                            onOpenThread: onOpenThread,
                            onTemplate: onTemplate
                        )
                        .equatable()
                    }
                }
            }
        }

        if snapshot.working && store.status == .connected && pendingApprovals.isEmpty && pendingQuestion == nil {
            // Mobile's live fold row and `ThinkingTimelineRow`. A running work group already
            // carries the "Working for" row; without one it stands alone.
            let running = snapshot.workGroups.contains(where: \.hasActive)
            let start = snapshot.activeWorkStartedAtMs
            let offset = snapshot.serverClockOffsetMs
            let live = liveWork
            // Under a running group's "Working for" row: the paragraph gap, as above.
            add("live", extra: running ? foldGap : 0, key: feedSignature(live.label, live.icon, running, start, offset)) {
                VStack(alignment: .leading, spacing: 0) {
                    if !running { WorkingFold(startedAtMs: start, offsetMs: offset) }
                    LiveWorkRow(label: live.label, glyph: live.icon)
                }
            }
        }
        // Desktop: queued messages sit at the very bottom, after the live row.
        let queued = snapshot.entries.compactMap(QueuedMessage.init)
        if !queued.isEmpty {
            let editBlocked = pendingQuestion != nil || !pendingApprovals.isEmpty
            let queuedEntries = snapshot.entries.filter { QueuedMessage($0) != nil }
            add("queued-messages", key: feedSignature(queuedEntries, editBlocked, shellStamp)) { [store, threadId] in
                QueuedMessagesSection(threadId: threadId, messages: queued, store: store, editBlocked: editBlocked)
            }
        }
        return rows
    }

    private var composerArea: some View {
        ThreadComposerArea(
            store: store,
            threadId: threadId,
            pendingApprovals: pendingApprovals,
            pendingQuestion: pendingQuestion,
            isWorking: isWorking,
            readingHistory: readingWindow != nil,
            historyNotice: historyNotice,
            viewHeight: viewSize.height,
            modelDriver: modelPicker?.selectedDriver,
            modelLabel: modelPicker?.selectedLabel ?? snapshot?.modelLabel,
            onModelChip: { showingModelPicker = true },
            onSendReply: { sendDraft() }
        )
    }

    /// What the running turn does now, for the live row: a running tool, the subagents it waits on,
    /// or thinking (mobile `liveToolActivitySummary`, `waitingOnSubagentsLabel`).
    private var liveWork: (label: String, icon: String) {
        guard let snapshot else { return ("Thinking", "thinking") }
        let last = snapshot.entries.last { if case .queuedUser = $0 { false } else { true } }
        if case let .tool(_, kind, title, _, .running, _, _, _)? = last {
            return (connToolLabel(title: title)?.displayName ?? (title.isEmpty ? kind : title), "thinking")
        }
        let waiting = turnSubagents.filter { !$0.settled }.count
        if waiting > 0 {
            return (waiting == 1 ? "Waiting on a subagent" : "Waiting on \(waiting) subagents", "thinking")
        }
        return ("Thinking", "thinking")
    }

    struct TurnSubagent: Identifiable {
        let id: String
        let title: String
        let child: String?
        let environment: String?
        let settled: Bool
        let status: String
        let state: FfiTurnItemStatus
        let provider: String?
        let model: String?
        let updatedAt: String?
    }

    /// Logs the first frame that draws this thread's messages, once per open.
    private func logFirstFrame(_ snapshot: FfiThreadSnapshot) {
        guard openedAt != .distantPast,
              frameLogged.thread != threadId || frameLogged.openedAt != openedAt else { return }
        frameLogged.thread = threadId
        frameLogged.openedAt = openedAt
        let ms = Int(Date().timeIntervalSince(openedAt) * 1000)
        CoreStore.openLog.info("frame thread=\(threadId, privacy: .public) entries=\(snapshot.entries.count) capsule=\(turnSubagents.count) ms=\(ms)")
    }

    /// The latest turn's agents, plus any still live from an earlier turn, from the projection's
    /// subagents and runs (the core's `turn_agents`, mobile's `deriveThreadTurnSubagents`): there
    /// with the first projection, and a delegated completion row never ends the turn.
    private var turnSubagents: [TurnSubagent] {
        (snapshot?.turnAgents?.agents ?? []).map { agent in
            TurnSubagent(id: agent.id, title: agent.title, child: agent.childThreadId,
                         environment: agent.environmentId, settled: agent.settled,
                         status: agent.statusLabel, state: agent.status, provider: agent.provider,
                         model: agent.model, updatedAt: agent.completedAt ?? agent.startedAt ?? agent.updatedAt)
        }
    }

    /// Mobile's `FloatingWorkingControl`, above the approvals and the composer: a glass capsule for
    /// the running subagents ("2/3", or "3 done" once they settle) and the jump-to-latest circle,
    /// 16 apart, 12 above the composer.
    private var syncing: Bool {
        snapshot.map { !$0.synchronized } ?? false && !store.showsOffline && readingWindow == nil
    }

    /// The agents or syncing capsule floats over the end of the feed.
    private var capsuleShown: Bool { !turnSubagents.isEmpty || syncing }

    /// The floating row: the 44 pt control and 9.25 pt under it (a 12 pt gap to the composer).
    static let floatingRowHeight: CGFloat = 44 + 9.25

    private var floatingControl: some View {
        FeedFloatingControl(
            chrome: chrome,
            agents: turnSubagents,
            liveCount: Int(snapshot?.turnAgents?.liveCount ?? 0),
            settledCount: Int(snapshot?.turnAgents?.settledCount ?? 0),
            syncing: syncing,
            onJump: { latest() },
            onAgents: { showsAgents = true }
        )
    }

    private func sendDraft() {
        // Follow the end, so the sent message and the reply stay in view.
        scrollRequest = FeedScrollRequest(target: .end)
        let draft = composer
        let mode: FfiSendMode = store.followUpSteers(threadId) ? .steer : .queue
        Task {
            _ = await store.submit(draft, for: .thread(threadId), to: .reply(threadId: threadId, mode: mode))
        }
    }

    /// A message the user wrote (not an agent-authored row such as a delegated result).
    private static func isLogRow(_ item: RenderItem) -> Bool {
        guard case let .entry(entry) = item else { return false }
        switch entry {
        case .userInputRequest, .approval: return true
        default: return false
        }
    }

    private static func isUserMessage(_ item: RenderItem) -> Bool {
        guard case let .entry(entry) = item else { return false }
        switch entry {
        case let .user(_, _, _, byAgent, _, _, _): return !byAgent
        case let .queuedUser(_, _, _, _, _, byAgent, _): return !byAgent
        default: return false
        }
    }

    private enum RenderItem: Identifiable {
        case workGroup(FfiWorkGroupTiming, [FfiTimelineEntry])
        case entry(FfiTimelineEntry)

        var id: String {
            switch self {
            case let .workGroup(group, _): "wg:\(group.id)"
            case let .entry(entry): "e:\(entry.entryId)"
            }
        }
    }

    private func renderItems(for snapshot: FfiThreadSnapshot) -> [RenderItem] {
        var groupByFirstId: [String: FfiWorkGroupTiming] = [:]
        var memberIds = Set<String>()
        for group in snapshot.workGroups {
            groupByFirstId[group.firstEntryId] = group
            for id in group.entryIds {
                memberIds.insert(id)
            }
        }

        let entriesById = Dictionary(snapshot.entries.map { ($0.entryId, $0) }, uniquingKeysWith: { first, _ in first })
        var items: [RenderItem] = []

        let waiting = Set(pendingApprovals.map(\.entryId))
        for entry in snapshot.entries {
            let id = entry.entryId
            if waiting.contains(id) || QueuedMessage(entry) != nil { continue }
            if let group = groupByFirstId[id] {
                let groupedEntries = group.entryIds.compactMap { entriesById[$0] }
                if !groupedEntries.isEmpty {
                    items.append(.workGroup(group, groupedEntries))
                }
            } else if memberIds.contains(id) {
                continue
            } else {
                items.append(.entry(entry))
            }
        }
        // A message sent while the agent works lands after the running group, which split
        // "Working for" from the live row drawn at the end. Keep the running group last, under
        // the messages sent during it, so the fold and its live row stay together.
        if let index = items.lastIndex(where: { if case let .workGroup(group, _) = $0 { group.hasActive } else { false } }),
           index < items.count - 1,
           items[(index + 1)...].allSatisfy({ item in
               if case let .entry(entry) = item {
                   switch entry {
                   case .user, .queuedUser: return true
                   default: return false
                   }
               }
               return false
           }) {
            items.append(items.remove(at: index))
        }
        return items
    }
}

/// SwiftUI turns off UIKit's edge pop when a screen supplies its own back button.
private struct ThreadEdgePopGesture: UIViewControllerRepresentable {
    func makeUIViewController(context: Context) -> Controller { Controller() }
    func updateUIViewController(_ controller: Controller, context: Context) {}

    final class Controller: UIViewController, UIGestureRecognizerDelegate {
        private weak var pop: UIGestureRecognizer?
        private weak var previousDelegate: (any UIGestureRecognizerDelegate)?
        private var previouslyEnabled = false

        override func viewDidAppear(_ animated: Bool) {
            super.viewDidAppear(animated)
            guard let gesture = navigationController?.interactivePopGestureRecognizer,
                  gesture.delegate !== self else { return }
            pop = gesture
            previousDelegate = gesture.delegate
            previouslyEnabled = gesture.isEnabled
            gesture.delegate = self
            gesture.isEnabled = true
        }

        override func viewDidDisappear(_ animated: Bool) {
            super.viewDidDisappear(animated)
            if let pop, pop.delegate === self {
                pop.delegate = previousDelegate
                pop.isEnabled = previouslyEnabled
            }
        }

        func gestureRecognizerShouldBegin(_ gestureRecognizer: UIGestureRecognizer) -> Bool {
            guard let navigationController else { return false }
            return navigationController.viewControllers.count > 1 && navigationController.transitionCoordinator == nil
        }
    }
}

/// Which open of a thread already logged its first frame.
private final class FrameLog {
    var thread: String?
    var openedAt: Date?
}

/// The floating row over the end of the feed. It is a separate host from the composer, and never
/// changes the feed's inset itself, so the jump circle coming and going can't move the feed and
/// flip itself again.
struct FeedFloatingControl: View {
    let chrome: FeedChrome
    let agents: [ThreadView.TurnSubagent]
    let liveCount: Int
    let settledCount: Int
    let syncing: Bool
    let onJump: () -> Void
    let onAgents: () -> Void
    @Environment(\.connTheme) private var theme
    @Namespace private var floatingGlass

    var body: some View {
        let showsJump = chrome.showsJump
        let visible = showsJump || !agents.isEmpty || syncing
        // Merge spacing 8, as the composer's container had: the controls never blend.
        GlassEffectContainer(spacing: 8) {
            // The row stays in place, so the jump circle can fade and shrink out, the reverse of how
            // it appears; removing the row with it used to cut the exit short.
            HStack(spacing: 16) {
                if syncing { syncingCapsule }
                if !agents.isEmpty { agentsCapsule }
                if showsJump {
                    Button {
                        UISelectionFeedbackGenerator().selectionChanged()
                        onJump()
                    } label: {
                        ThreadGlyph(name: "chevron-down", size: 16)
                            .foregroundStyle(theme.foreground)
                            .frame(width: 38.5, height: 38.5)
                            .glassEffect(.regular.interactive(), in: .circle)
                            // The glass container draws the circle, so the glass makes its own
                            // entrance and exit: alone it materializes, beside the agents capsule it
                            // morphs out of and back into it. The chevron only fades in place.
                            .glassEffectID("jump", in: floatingGlass)
                            .glassEffectTransition(agents.isEmpty ? .materialize : .matchedGeometry)
                            .frame(width: 44, height: 44)
                            .contentShape(Rectangle())
                    }
                    .buttonStyle(.plain)
                    .transition(.opacity)
                    .accessibilityLabel("Jump to latest")
                    .accessibilityIdentifier("thread.scrollToEnd")
                }
            }
            .onGeometryChange(for: CGRect.self) { $0.frame(in: .named(Self.space)) } action: { chrome.reportFloatingFrame($0) }
        }
        .frame(maxWidth: .infinity)
        // The 38.5 pt circle sits 2.75 pt inside its 44 pt frame: 9.25 more makes a 12 pt gap.
        .padding(.bottom, visible ? 9.25 : 0)
        .frame(maxHeight: .infinity, alignment: .bottom)
        // The capsule re-centres as the jump circle morphs in or out, both ways.
        .animation(.smooth(duration: 0.35), value: showsJump)
        .animation(.smooth(duration: 0.35), value: visible)
        // The host's own space: the frame is where its pass-through view lets touches in.
        .coordinateSpace(.named(Self.space))
    }

    private static let space = "feed.floating"

    /// "Syncing" while the feed still shows cached state, in the agents capsule's style.
    private var syncingCapsule: some View {
        HStack(spacing: 6) {
            ProgressView().controlSize(.mini).tint(theme.mutedForeground)
            Text("Syncing")
                .font(.system(size: 12, weight: .medium))
                .foregroundStyle(theme.foreground)
        }
        .padding(.horizontal, 12)
        .frame(height: 38.5)
        .glassEffect(.regular, in: .capsule)
        .frame(height: 44)
        .accessibilityElement(children: .combine)
        .accessibilityLabel("Syncing the latest messages")
        .accessibilityIdentifier("thread.syncing")
    }

    private var agentsCapsule: some View {
        let label = liveCount > 0 ? "\(liveCount)/\(agents.count)" : "\(settledCount) done"
        return Button {
            UISelectionFeedbackGenerator().selectionChanged()
            onAgents()
        } label: {
            HStack(spacing: 6) {
                ThreadGlyph(name: "users", size: 14)
                    .font(.system(size: 13))
                    .foregroundStyle(theme.mutedForeground)
                Text(label)
                    .font(.system(size: 12, weight: .medium))
                    .monospacedDigit()
                    .foregroundStyle(theme.foreground)
            }
            .padding(.horizontal, 12)
            // Mobile's 38.5pt control in a 44pt target, like the jump circle beside it.
            .frame(height: 38.5)
            .glassEffect(.regular.interactive(), in: .capsule)
            .glassEffectID("agents", in: floatingGlass)
            .frame(height: 44)
            .contentShape(Capsule())
        }
        .accessibilityLabel(liveCount > 0 ? "Open agents, \(liveCount) of \(agents.count) agents working"
                            : "Open agents, \(settledCount) done")
        .buttonStyle(.plain)
        .accessibilityIdentifier("thread.agents")
    }
}

/// A row's content signature for the feed (`FeedRow.signature`).
func feedSignature(_ parts: AnyHashable?...) -> Int {
    var hasher = Hasher()
    for part in parts { hasher.combine(part) }
    return hasher.finalize()
}
