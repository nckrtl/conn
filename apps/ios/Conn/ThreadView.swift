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
    @Namespace private var floatingGlass
    /// The feed's tail marker is in the visible region (`onScrollVisibilityChange`).
    @State private var bottomVisible = false
    @State private var historyNotice: String?
    @State private var scrollTarget: String?
    @State private var historyRequest = UUID()
    @State private var viewport = TimelineViewport()
    @State private var prependAnchor: UnitPoint?
    @State private var requestedByScroll = false
    @State private var paging = false
    @State private var pageExhausted = false
    @State private var userScrolling = false
    @State private var stickToBottom = true
    /// When this thread opened. Content that lands during the push jumps to the end unanimated.
    @State private var openedAt = Date.distantPast
    @State private var settled: Bool
    @State private var showingRename = false
    @State private var renameDraft = ""
    /// The approval whose answer is on its way; its buttons stay off until the server answers.
    @State private var respondingApprovalId: String?
    /// Each open question's answers so far, by request id, then question id.
    @State private var questionDrafts: [String: [String: FfiQuestionDraft]] = [:]
    /// The step each open question shows, by request id.
    @State private var questionSteps: [String: Int] = [:]
    /// The question whose answers are on their way.
    @State private var respondingUserInputId: String?
    /// The step whose single-choice pick is about to move on (mobile's 200 ms).
    @State private var advancingStep: Int?
    @State private var advanceTask: Task<Void, Never>?
    @State private var viewSize: CGSize = .zero

    private var composer: ComposerDraft { store.composerDraft(.thread(threadId)) }
    private var draft: String {
        get { composer.text }
        nonmutating set { composer.text = newValue }
    }

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

    /// An approval gives up height to the feed: at most 560pt, at least 160pt, and never more
    /// than the screen leaves above the composer (`derivePendingUserInputMaxHeight`).
    private var approvalMaxHeight: CGFloat {
        min(560, max(160, viewSize.height - 140))
    }

    private var pendingApprovals: [FfiPendingApproval] {
        readingWindow == nil && store.status == .connected ? snapshot?.pendingApprovals ?? [] : []
    }
    private var pendingQuestion: FfiPendingQuestion? {
        readingWindow == nil && pendingApprovals.isEmpty && store.status == .connected ? snapshot?.pendingQuestion : nil
    }

    /// The open question's panel for its current step; the composer's text shows as the answer.
    private var questionPanelModel: FfiQuestionPanel? {
        guard let question = pendingQuestion else { return nil }
        return questionPanel(
            pending: question,
            step: UInt32(clamping: questionSteps[question.requestId] ?? 0),
            drafts: questionDrafts[question.requestId] ?? [:],
            typedAnswer: draft,
            responding: respondingUserInputId == question.requestId
        )
    }

    /// The panel leaves some of the feed in view above itself (`QUESTION_PANEL_FEED_PEEK`).
    private var questionMaxHeight: CGFloat {
        min(560, max(160, viewSize.height - 140 - 96))
    }

    private func setQuestionStep(_ step: Int, for question: FfiPendingQuestion) {
        advanceTask?.cancel()
        advanceTask = nil
        advancingStep = nil
        questionSteps[question.requestId] = max(0, step)
    }

    private func selectQuestionOption(_ value: String, question: FfiPendingQuestion, panel: FfiQuestionPanel) {
        UISelectionFeedbackGenerator().selectionChanged()
        questionDrafts[question.requestId] = questionToggleOption(
            pending: question,
            questionId: panel.questionId,
            drafts: questionDrafts[question.requestId] ?? [:],
            value: value
        )
        guard panel.advancesOnPick else { return }
        advanceTask?.cancel()
        let step = Int(panel.step)
        advancingStep = step
        advanceTask = Task { @MainActor in
            try? await Task.sleep(for: .milliseconds(200))
            guard !Task.isCancelled else { return }
            advanceTask = nil
            advancingStep = nil
            questionSteps[question.requestId] = step + 1
        }
    }

    private func submitQuestion(_ question: FfiPendingQuestion) {
        guard let answers = questionAnswers(
            pending: question,
            drafts: questionDrafts[question.requestId] ?? [:]
        ) else { return }
        respondingUserInputId = question.requestId
        Task {
            await store.respondUserInput(threadId: threadId, requestId: question.requestId, answers: answers)
            if respondingUserInputId == question.requestId {
                respondingUserInputId = nil
            }
        }
    }

    private func dismissQuestion(_ question: FfiPendingQuestion) {
        respondingUserInputId = question.requestId
        Task {
            await store.dismissUserInput(threadId: threadId, requestId: question.requestId)
            if respondingUserInputId == question.requestId {
                respondingUserInputId = nil
            }
        }
    }

    /// Text sent while a question is open answers it: the prompt box is the free-text answer.
    private func answerQuestion(with text: String, question: FfiPendingQuestion, panel: FfiQuestionPanel) {
        questionDrafts[question.requestId] = questionSetCustomAnswer(
            pending: question,
            questionId: panel.questionId,
            drafts: questionDrafts[question.requestId] ?? [:],
            text: text
        )
        draft = ""
        if panel.isLast {
            submitQuestion(question)
        } else {
            setQuestionStep(Int(panel.step) + 1, for: question)
        }
    }

    /// The composer's send button with no text: the next question, or the answers.
    private func runAnswerAction(question: FfiPendingQuestion, panel: FfiQuestionPanel) {
        if panel.isLast {
            submitQuestion(question)
        } else {
            setQuestionStep(Int(panel.step) + 1, for: question)
        }
    }

    private func respond(to approval: FfiPendingApproval, with decision: FfiApprovalDecision) {
        respondingApprovalId = approval.requestId
        Task {
            await store.respondApproval(
                threadId: threadId,
                requestId: approval.requestId,
                decision: decision
            )
            if respondingApprovalId == approval.requestId {
                respondingApprovalId = nil
            }
        }
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

    private var hasDraft: Bool {
        pendingQuestion == nil ? composer.hasContent : !draft.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
    }

    /// With a question open, text answers it and an empty composer runs the answer action.
    private var overlayHasCards: Bool {
        !pendingApprovals.isEmpty || questionPanelModel != nil
            || historyNotice != nil || (store.showsOffline && !store.showsSavedConnectionAlert)
    }

    private var composerCanSend: Bool {
        guard store.status == .connected, readingWindow == nil else { return false }
        guard let question = pendingQuestion, let panel = questionPanelModel else {
            return hasDraft && !composer.locked
        }
        if hasDraft {
            return panel.acceptsText && question.answerable
                && respondingUserInputId != question.requestId
        }
        return panel.answerActionReady
    }

    private var scrollFingerprint: String {
        guard let snapshot else { return "loading" }
        let last = snapshot.entries.last.map(entryFingerprint) ?? "empty"
        return "\(snapshot.entries.count):\(snapshot.working):\(snapshot.queuedCount):\(last)"
    }

    private func latest() {
        historyRequest = UUID()
        requestedByScroll = false
        prependAnchor = nil
        paging = false
        pageExhausted = false
        readingWindow = nil
        historyNotice = nil
        stickToBottom = true
        // A tap ends any coasting scroll's pending decision: its idle callback used to recompute
        // the pin and bring the jump button back, so it took a second tap.
        userScrolling = false
        scrollTarget = "timeline-bottom"
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
                    stickToBottom = false
                    readingWindow = window
                    scrollTarget = "e:" + prompt
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
                    stickToBottom = false
                    let visible = viewport.frames.filter { $0.value.minY >= 0 && $0.value.minY < viewSize.height }
                        .min { $0.value.minY < $1.value.minY }
                    readingWindow = current
                    if let visible {
                        let fraction = visible.value.minY / max(1, viewSize.height - visible.value.height)
                        prependAnchor = UnitPoint(x: 0.5, y: min(1, fraction))
                        scrollTarget = visible.key
                    }
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
        ScrollViewReader { proxy in
            // The feed runs under the header and composer, and iOS's soft scroll edge blurs it
            // there, as Conn mobile's EdgeBlur does.
            timeline(proxy)
                .safeAreaBar(edge: .bottom, spacing: 0) {
                    composerArea(proxy)
                        .onGeometryChange(for: CGFloat.self) { $0.size.height } action: { old, new in
                            if old != new && stickToBottom && !userScrolling && readingWindow == nil {
                                proxy.scrollTo("timeline-bottom", anchor: .bottom)
                            }
                        }
                }
                .scrollEdgeEffectStyle(.soft, for: .all)
                .background(theme.background.ignoresSafeArea())
        }
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
        .onChange(of: pendingQuestion?.requestId) { _, current in
            // Drafts of answered, skipped or expired questions go (`pruneResolvedRequestDrafts`).
            questionDrafts = questionDrafts.filter { $0.key == current }
            questionSteps = questionSteps.filter { $0.key == current }
        }
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
            if !stickToBottom && readingWindow == nil {
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

    private func timeline(_ proxy: ScrollViewProxy) -> some View {
        ScrollView {
            // Lab `.m-feed-inner`: 36 between messages, so each message groups with its own parts.
            LazyVStack(alignment: .leading, spacing: ThreadFeed.spacing) {
                if let error = store.lastError, !error.isEmpty {
                    KitNotice(error, icon: .warning, tone: .error)
                }

                if let snapshot {
                    if canReadEarlier {
                        Button("Earlier messages") { readHistory() }
                            .disabled(paging)
                            .font(.kitDetail)
                    }
                    if let setup, setup.threadId == threadId, readingWindow == nil { ThreadWorktreeCard(setup: setup) }
                    if snapshot.entries.isEmpty {
                        Text(store.status == .connected ? "No messages in this thread yet." : "No saved messages for this thread.")
                            .font(.kitDetail)
                            .foregroundStyle(theme.mutedForeground)
                            .frame(maxWidth: .infinity)
                            .padding(.vertical, 48)
                    } else {
                        let items = renderItems(for: snapshot)
                        let anchorCandidates = Set(items.prefix(12).map(\.id))
                        // What follows a "Worked for" row sits a paragraph gap below it, not the
                        // feed spacing. The row keeps its own height (a near-zero frame stops drawing).
                        let afterFold = Set(zip(items, items.dropFirst()).compactMap { pair -> String? in
                            if case .workGroup = pair.0 { return pair.1.id } else { return nil }
                        })
                        ForEach(items) { item in
                            Group {
                                switch item {
                                case let .workGroup(group, entries):
                                    WorkGroupCard(group: group, entries: entries)
                                case let .entry(entry):
                                    TimelineEntryRow(
                                        threadId: threadId,
                                        entry: entry,
                                        store: store,
                                        detail: snapshot.feedDetails[entry.entryId],
                                        interactive: readingWindow == nil && store.status == .connected,
                                        onOpenThread: onOpenThread,
                                        onTemplate: onTemplate
                                    )
                                }
                            }
                            .background {
                                if anchorCandidates.contains(item.id) {
                                    GeometryReader { geometry in
                                        Color.clear.preference(
                                            key: TimelineFrames.self,
                                            value: [item.id: geometry.frame(in: .named("timeline-viewport"))]
                                        )
                                    }
                                }
                            }
                            .padding(.top, afterFold.contains(item.id) ? foldGap : 0)
                            .id(item.id)
                        }
                    }

                    if snapshot.working && store.status == .connected && pendingApprovals.isEmpty && pendingQuestion == nil {
                        // Mobile's live fold row and `ThinkingTimelineRow`. A running work group
                        // already carries the "Working for" row; without one it stands alone.
                        VStack(alignment: .leading, spacing: 0) {
                            if !snapshot.workGroups.contains(where: \.hasActive) {
                                WorkingFold(since: runStartedAt(in: snapshot))
                            }
                            LiveWorkRow(label: liveWork.label, glyph: liveWork.icon)
                        }
                        // Under a running group's "Working for" row: the paragraph gap, as above.
                        .padding(.top, snapshot.workGroups.contains(where: \.hasActive) ? foldGap : 0)
                        // The gap under the divider is the fold's own paragraph gap, as above it.
                    }
                } else {
                    HStack(spacing: Kit.Space.m) {
                        KitStatusIcon(.working, size: 16, label: "Loading")
                        Text("Loading timeline…")
                            .font(.kitDetail)
                            .foregroundStyle(theme.mutedForeground)
                    }
                    .frame(maxWidth: .infinity)
                    .padding(.vertical, 48)
                }

                Color.clear
                    .frame(height: 1)
                    .id("timeline-bottom")
                    // iOS's own measure of the tail being on screen, beside the inset arithmetic.
                    .onScrollVisibilityChange(threshold: 0.5) { bottomVisible = $0 }
            }
            .scrollTargetLayout()
            // A tap on the feed puts the keyboard away; simultaneous, so links, cards and buttons still
            // work. On the feed content, not the ScrollView: the composer is the ScrollView's
            // safeAreaBar, and a tap on Send there resigned the keyboard and SwiftUI focus brought it back.
            .contentShape(Rectangle())
            .simultaneousGesture(TapGesture().onEnded {
                UIApplication.shared.sendAction(#selector(UIResponder.resignFirstResponder), to: nil, from: nil, for: nil)
            })
            // Card edges line up with the composer's 12-point inset.
            .padding(.horizontal, 12)
            .padding(.top, 12)
            // The stack gap and bottom anchor already contribute 13 of the 14 points.
            .padding(.bottom, 1)
        }
        .background(theme.background.ignoresSafeArea())
        .defaultScrollAnchor(.bottom, for: .alignment)
        .defaultScrollAnchor(.bottom, for: .initialOffset)
        // Thread links in messages (`t3-thread://v2/…`, `conn://thread/…`) open in the app; other
        // links go to the system.
        .environment(\.openURL, OpenURLAction { url in
            guard let link = ThreadLink(url: url) else { return .systemAction }
            onOpenThread(link.threadId, link.environmentId)
            return .handled
        })
        .coordinateSpace(name: "timeline-viewport")
        .onPreferenceChange(TimelineFrames.self) { viewport.frames = $0 }
        .onScrollPhaseChange { _, phase, context in
            // The finger owns the feed: stop pinning to the end the moment a scroll starts, and
            // decide again only once it settles (an update mid-drag used to pull the feed down).
            if phase == .interacting {
                userScrolling = true
                stickToBottom = false
            }
            if phase == .idle {
                // Re-pin only when the scroll settles at the very end, not merely near it: a short
                // drag up used to land within the 80 pt "near end" and re-pin at release.
                if userScrolling { stickToBottom = bottomVisible || TimelineEdges(context.geometry).atEnd }
                userScrolling = false
                if requestedByScroll {
                    requestedByScroll = false
                    readHistory()
                }
            }
        }
        .onScrollGeometryChange(for: TimelineEdges.self, of: { TimelineEdges($0) }) { previous, edges in
            if userScrolling {
                // Mid-gesture the pin can only be dropped, never taken back.
                if !edges.atEnd && !bottomVisible { stickToBottom = false }
                if edges.top < previous.top && !paging { requestedByScroll = true }
            }
        }
        .scrollDismissesKeyboard(.interactively)
        .onChange(of: scrollFingerprint) { old, _ in
            guard stickToBottom && !userScrolling && readingWindow == nil else { return }
            // The first snapshot and the updates right after opening are not new messages: an
            // animated scroll there ran during the push and looked like the thread scrolling down.
            if old == "loading" || Date().timeIntervalSince(openedAt) < 1 {
                proxy.scrollTo("timeline-bottom", anchor: .bottom)
            } else {
                withAnimation(Kit.Motion.fast) {
                    proxy.scrollTo("timeline-bottom", anchor: .bottom)
                }
            }
        }
        .onChange(of: scrollTarget) { _, target in
            if let target {
                proxy.scrollTo(target, anchor: prependAnchor ?? (target == "timeline-bottom" ? .bottom : .top))
                prependAnchor = nil
                scrollTarget = nil
            }
        }
        .onGeometryChange(for: CGFloat.self) { $0.size.height } action: { old, new in
            if old != new && stickToBottom && !userScrolling && readingWindow == nil {
                proxy.scrollTo("timeline-bottom", anchor: .bottom)
            }
        }
    }

    private func composerArea(_ proxy: ScrollViewProxy) -> some View {
        // Merge spacing 8: below the 12pt gap kept between the floating control and the composer, so
        // the jump circle never blends into the prompt box's glass, also as the box grows.
        GlassEffectContainer(spacing: 8) {
          VStack(alignment: .leading, spacing: 0) {
            // The 38.5pt circle sits 2.75pt inside its 44pt frame: 9.25 more makes a 12pt gap.
            floatingControl().padding(.bottom, 9.25)
          VStack(alignment: .leading, spacing: 10.5) {
            if let historyNotice {
                Text(historyNotice).font(.kitDetail)
            }
            if store.showsOffline && !store.showsSavedConnectionAlert {
                OfflinePill(store: store).frame(maxWidth: .infinity)
            }
            // Conn mobile pins the first pending approval above the composer.
            if let approval = pendingApprovals.first {
                HeightCappedScroll(maxHeight: approvalMaxHeight) {
                    PendingApprovalCard(
                        approval: approval,
                        remaining: pendingApprovals.count,
                        responding: respondingApprovalId == approval.requestId
                    ) { decision in
                        respond(to: approval, with: decision)
                    }
                }
                .modifier(ComposerDeck(remaining: pendingApprovals.count))
                .id(approval.requestId)
                .transition(.opacity.combined(with: .move(edge: .bottom)))
            }
            if let question = pendingQuestion, let panel = questionPanelModel {
                PendingUserInputCard(
                    question: question,
                    panel: panel,
                    responding: respondingUserInputId == question.requestId,
                    advancing: advancingStep == Int(panel.step),
                    maxHeight: questionMaxHeight,
                    onSelectOption: { value in
                        selectQuestionOption(value, question: question, panel: panel)
                    },
                    onStepChange: { step in
                        UISelectionFeedbackGenerator().selectionChanged()
                        setQuestionStep(step, for: question)
                    },
                    onSubmit: { submitQuestion(question) },
                    onDismiss: { dismissQuestion(question) }
                )
                .modifier(ComposerDeck(remaining: question.questions.count - Int(panel.step)))
                .id(question.requestId)
                .transition(.opacity.combined(with: .move(edge: .bottom)))
            }
          }
          // Cards: `px-[14px] pb-[7px] gap-2.5` (2pt more than the composer's 12).
          .padding(.horizontal, 2)
          .padding(.bottom, overlayHasCards ? 7 : 0)

            ConnComposerPill(
                placeholder: questionPanelModel?.composerPlaceholder
                    ?? (isWorking ? "Queue a follow-up…" : "Ask anything"),
                draft: composer,
                limits: store.composerLimits,
                allowsAttachments: questionPanelModel == nil,
                isBusy: isWorking && !hasDraft && questionPanelModel == nil,
                canSend: composerCanSend,
                onSend: {
                    if let question = pendingQuestion, let panel = questionPanelModel {
                        if hasDraft {
                            answerQuestion(with: draft, question: question, panel: panel)
                        } else {
                            runAnswerAction(question: question, panel: panel)
                        }
                    } else {
                        sendDraft(scrollProxy: proxy)
                    }
                },
                onStop: {
                    Task {
                        await store.stopThread(threadId: threadId)
                    }
                },
                trailing: {
                    HStack(spacing: 0) {
                        if isWorking && hasDraft && questionPanelModel == nil {
                            Button {
                                Task {
                                    await store.stopThread(threadId: threadId)
                                }
                            } label: {
                                // Lab `.ios-stop`: a bare 13 pt `stop` in the text colour.
                                ThreadGlyph(name: "stop", size: 13)
                                    .foregroundStyle(theme.foreground)
                                    .frame(minHeight: 44)
                                    .contentShape(Rectangle())
                            }
                            .buttonStyle(.plain)
                            .accessibilityLabel("Stop")
                        }
                        ConnComposerModelChip(
                            driver: modelPicker?.selectedDriver,
                            modelLabel: modelPicker?.selectedLabel ?? snapshot?.modelLabel
                        ) {
                            showingModelPicker = true
                        }
                    }
                }
            )
            .id(ObjectIdentifier(composer))
            .disabled(store.status != .connected || readingWindow != nil)
            .accessibilityIdentifier("thread.composer")
          }
        }
        // `ThreadComposer`: `px-[12px]`, and 2pt (`COMPOSER_BOTTOM_GUTTER`) above the safe area.
        .padding(.horizontal, ComposerSheet.screenInset)
        .padding(.bottom, ComposerSheet.bottomGutter)
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

    private func runStartedAt(in snapshot: FfiThreadSnapshot) -> Date {
        for entry in snapshot.entries.reversed() {
            if case let .user(_, _, createdAt, _, _, _, _) = entry, let date = threadDate(createdAt) { return date }
        }
        return Date()
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

    /// The subagents of the latest turn (those after the last user message) plus any still running
    /// from an earlier turn, so a reply never hides live agents (mobile's `deriveThreadTurnSubagents`).
    private var turnSubagents: [TurnSubagent] {
        guard let snapshot else { return [] }
        let start = snapshot.entries.lastIndex { if case .user = $0 { true } else { false } }
            .map { $0 + 1 } ?? 0
        return snapshot.entries.indices.compactMap { index in
            let entry = snapshot.entries[index]
            guard case let .subagent(id, child, title, _, state, label, settled, _, _, created, started, completed) = entry,
                  index >= start || !settled else { return nil }
            var thread = child
            var environment: String?
            var provider: String?
            var model: String?
            if case let .subagent(driver, slug, _, env, linked)? = snapshot.feedDetails[id] {
                thread = linked ?? child
                environment = env
                provider = driver
                model = slug
            }
            return TurnSubagent(id: id, title: title, child: thread, environment: environment,
                                settled: settled, status: label, state: state, provider: provider,
                                model: model, updatedAt: completed ?? started ?? created)
        }
    }

    /// Mobile's `FloatingWorkingControl`, above the approvals and the composer: a glass capsule for
    /// the running subagents ("2/3", or "3 done" once they settle) and the jump-to-latest circle,
    /// 16 apart, 12 above the composer.
    @ViewBuilder
    private func floatingControl() -> some View {
        let agents = turnSubagents
        let showsJump = snapshot != nil && (!stickToBottom || readingWindow != nil)
        // A cached or restored feed the live projection hasn't replaced yet, while connected or
        // connecting (never while the offline pill shows).
        let syncing = snapshot.map { !$0.synchronized } ?? false && !store.showsOffline && readingWindow == nil
        if showsJump || !agents.isEmpty || syncing {
            HStack(spacing: 16) {
                if syncing { syncingCapsule }
                if !agents.isEmpty { agentsCapsule(agents) }
                if showsJump {
                    Button {
                        UISelectionFeedbackGenerator().selectionChanged()
                        latest()
                    } label: {
                        ThreadGlyph(name: "chevron-down", size: 16)
                            .foregroundStyle(theme.foreground)
                            .frame(width: 38.5, height: 38.5)
                            .glassEffect(.regular.interactive(), in: .circle)
                            // Grows out of, and dissolves back into, the agents capsule beside it.
                            .glassEffectID("jump", in: floatingGlass)
                            .glassEffectTransition(.matchedGeometry)
                            .frame(width: 44, height: 44)
                            .contentShape(Rectangle())
                    }
                    .buttonStyle(.plain)
                    .accessibilityLabel("Jump to latest")
                    .accessibilityIdentifier("thread.scrollToEnd")
                }
            }
            .frame(maxWidth: .infinity)
            // The capsule re-centres as the jump circle morphs in or out.
            .animation(.smooth(duration: 0.35), value: showsJump)
        }
    }

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

    private func agentsCapsule(_ agents: [TurnSubagent]) -> some View {
        let live = agents.filter { !$0.settled }.count
        let label = live > 0 ? "\(live)/\(agents.count)" : "\(agents.count) done"
        return Button {
            UISelectionFeedbackGenerator().selectionChanged()
            showsAgents = true
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
        .accessibilityLabel(live > 0 ? "Open agents, \(live) of \(agents.count) agents working" : "Open agents, \(agents.count) done")
        .buttonStyle(.plain)
        .accessibilityIdentifier("thread.agents")
    }

    private func sendDraft(scrollProxy: ScrollViewProxy) {
        stickToBottom = true
        let draft = composer
        let mode: FfiSendMode = store.followUpSteers(threadId) ? .steer : .queue
        Task {
            let sent = await store.submit(draft, for: .thread(threadId), to: .reply(threadId: threadId, mode: mode))
            // Only if the reader hasn't scrolled away while the send was in flight.
            if sent != nil, store.openThreadId == threadId, stickToBottom, !userScrolling {
                withAnimation(Kit.Motion.fast) {
                    scrollProxy.scrollTo("timeline-bottom", anchor: .bottom)
                }
            }
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

        let entriesById = Dictionary(uniqueKeysWithValues: snapshot.entries.map { ($0.entryId, $0) })
        var items: [RenderItem] = []

        let waiting = Set(pendingApprovals.map(\.entryId))
        for entry in snapshot.entries {
            let id = entry.entryId
            if waiting.contains(id) { continue }
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

private final class TimelineViewport {
    var frames: [String: CGRect] = [:]
}

private struct TimelineFrames: PreferenceKey {
    static let defaultValue: [String: CGRect] = [:]

    static func reduce(value: inout [String: CGRect], nextValue: () -> [String: CGRect]) {
        value.merge(nextValue(), uniquingKeysWith: { _, new in new })
    }
}

private struct TimelineEdges: Equatable {
    let top: Int
    let nearEnd: Bool
    /// Settled at the very end (8 pt of slack), the only place that re-pins to the tail.
    let atEnd: Bool

    init(_ geometry: ScrollGeometry) {
        top = Int(min(160, geometry.contentOffset.y + geometry.contentInsets.top))
        // The visible rect runs under the composer and keyboard inset; measure where the content
        // the reader can see ends, or "at the end" holds while scrolled up by the whole inset.
        let readableBottom = geometry.contentOffset.y + geometry.containerSize.height - geometry.contentInsets.bottom
        nearEnd = readableBottom >= geometry.contentSize.height - 80
        atEnd = readableBottom >= geometry.contentSize.height - 8
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
