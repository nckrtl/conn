import Foundation
import Observation
import OSLog
import SwiftUI

/// The launch path through Orbit, shown while no connection is up.
enum OrbitConnectState: Equatable {
    case connecting(String)
    case failed(message: String, detail: String?)
}

/// All machines that finish in one display frame commit together. A slow machine joins a later frame.
@MainActor
final class InboxPublications {
    private var pending: [String: () -> Void] = [:]

    func submit(scope: String, publish: @escaping () -> Void) {
        let schedule = pending.isEmpty
        pending[scope] = publish
        guard schedule else { return }
        Task {
            try? await Task.sleep(for: .milliseconds(16))
            let batch = pending
            pending.removeAll(keepingCapacity: true)
            for commit in batch.values { commit() }
        }
    }
}

/// One environment's store: the main one (`scope` empty) or a linked one. It renders its
/// `ConnSession`'s state. Rust owns the connection: which attempt counts, its status, what Retry
/// repeats, when to re-pair, and the offline cache.
@MainActor
@Observable
final class CoreStore {
    private(set) var state: FfiSessionState?
    private(set) var shell: FfiShellSnapshot?

    /// A thread's project title as the thread list shows it, or nil when this store doesn't list it.
    func linkProjectTitle(threadId: String) -> String? {
        guard let shell, let thread = shell.threads.first(where: { $0.id == threadId }) else { return nil }
        return thread.orbitProjectSlug ?? shell.projects.first(where: { $0.id == thread.projectId })?.title
    }
    private let publications: InboxPublications
    private(set) var openThread: FfiThreadSnapshot?
    /// The last session state lines (`logState`), newest last, for the offline pill's details.
    private(set) var sessionHistory: [String] = []
    private(set) var openThreadId: String?
    private(set) var offlineReader: OfflineReader?
    @ObservationIgnored let imageThumbnails = AttachmentThumbnails()
    @ObservationIgnored let uploads = ComposerUploads()
    private var readerConnection: UInt64?
    var lastError: String?
    /// A thread to show, set by a `conn://thread/...` URL or a push tap; the workspace consumes it.
    private(set) var pendingLink: ThreadLink?
    /// The thread inbox is on screen (no thread pushed, no sheet), for push suppression.
    var isInboxVisible = false
    /// Bumped whenever the server's provider list changes; model pickers re-read on it.
    private(set) var providersRevision = 0
    @ObservationIgnored private var drafts: [ComposerDraftKey: ComposerDraft] = [:]
    /// The files of replies still uploading, by their pending attachment id (`pending:<key>:<n>`),
    /// so the pending row shows them and their copies live until the upload has read them.
    @ObservationIgnored private(set) var pendingUploads: [String: ComposerFile] = [:]

    func composerDraft(_ key: ComposerDraftKey, initialText: String = "") -> ComposerDraft {
        if let existing = drafts[key] { return existing }
        let draft = ComposerDraft(text: initialText)
        draft.uploads = uploads
        drafts[key] = draft
        return draft
    }

    private func discardComposerDrafts() {
        for draft in drafts.values { draft.discard() }
        drafts.removeAll()
    }

    var composerLimits: FfiComposerLimits {
        _ = providersRevision
        return core?.composerLimits() ?? FfiComposerLimits(images: false, maxFileBytes: nil)
    }

    @ObservationIgnored private var session: ConnSession?
    private var core: ConnCore? { session?.core() }

    func pullRequest<T: Decodable>(_ operation: FfiPullRequestOperation, input: [String: Any], as: T.Type) async throws -> T {
        guard let core else { throw URLError(.notConnectedToInternet) }
        let data = try JSONSerialization.data(withJSONObject: input)
        let response = try await core.pullRequest(operation: operation, input: String(decoding: data, as: UTF8.self))
        return try JSONDecoder().decode(T.self, from: Data(response.utf8))
    }

    private(set) var fleetID: String?
    private(set) var fleetLabel: String?
    private(set) var discoveryError: String?
    private(set) var discovering = false
    private(set) var discoveredPrimary: String?
    private var lastFleetAttempt: Date?
    private(set) var loadingOlder = false
    private(set) var olderError: String?
    var showsOffline: Bool { state?.showsOffline == true }
    private var coldLaunchSession: FfiSavedSession?
    private var choseOffline = false
    var showsSavedConnectionAlert: Bool {
        scope.isEmpty && coldLaunchSession != nil && !choseOffline && !hasConnected && showsOffline && showsWorkspace
    }

    func useSavedWorkspaceOffline() { choseOffline = true }

    func retrySavedConnection() {
        guard let saved = coldLaunchSession else { return }
        if case .idle = state?.phase {
            perfMark(stage: "swift.store_launch")
            session?.launch(saved: saved)
        } else {
            session?.retry()
        }
        if let latest = session?.state() { handleState(latest) }
    }

    var displayName: String { fleetLabel ?? serverURL.flatMap { URL(string: $0)?.host } ?? fleetID ?? scope }

    var canLoadOlder: Bool { isPaired && !loadingOlder && (shell?.olderSettledCount ?? 0) > 0 }

    func loadOlder() {
        guard canLoadOlder, let core else { return }
        loadingOlder = true
        olderError = nil
        Task {
            defer { loadingOlder = false }
            do { try await core.loadOlderSettled() }
            catch { olderError = error.localizedDescription }
        }
    }

    let scope: String
    private(set) var linked: [String: CoreStore] = [:]
    private var linkedOrder: [String] = []
    var inboxOwners: [CoreStore] { [self] + linkedOrder.compactMap { linked[$0] } }

    private func registerLinked(_ child: CoreStore) {
        linked[child.scope] = child
        if !linkedOrder.contains(child.scope) {
            linkedOrder.append(child.scope)
            UserDefaults.standard.set(linkedOrder, forKey: "linkedSessions")
        }
    }

    /// The connection status the workspace shows inline. Once this scope has connected, a
    /// reconnect or re-pair shows here, so the workspace and its open thread stay up.
    var status: FfiConnectionStatus? {
        switch state?.phase {
        case let .live(status): status
        case .connecting where hasConnected: .connecting
        case let .failed(message, _, _) where hasConnected: .failed(message: message)
        default: nil
        }
    }

    var isPaired: Bool {
        if case .live = state?.phase { true } else { false }
    }

    /// Rust: this scope has had a working connection this launch.
    var hasConnected: Bool { state?.hasConnected ?? false }

    /// Rust: grows when this scope connects to a different server than before.
    var identityEpoch: UInt64 { state?.identityEpoch ?? 0 }

    private var hasPrimaryInventory = false

    var showsWorkspace: Bool {
        if hasPrimaryInventory { return true }
        // A saved primary can be unavailable while a linked machine already has its inventory.
        return scope.isEmpty && (coldLaunchSession != nil || hasConnected)
            && linked.values.contains { $0.shell != nil }
    }

    private func updateWorkspaceVisibility() {
        guard !hasPrimaryInventory else { return }
        if shell != nil && (hasConnected || coldLaunchSession != nil || offlineReader != nil) {
            hasPrimaryInventory = true
        }
    }
    var serverURL: String? { state?.serverUrl }
    /// The connected server's environment id.
    var environmentId: String? { state?.environmentId ?? coldLaunchSession?.environmentId }
    var attachmentEnvironment: String { environmentId ?? coldLaunchSession?.orbitServerId ?? scope }

    var orbitConnect: OrbitConnectState? {
        var phase = state?.phase
        #if DEBUG && targetEnvironment(simulator)
        switch ProcessInfo.processInfo.environment["CONN_TEST_LAUNCH_PHASE"] {
        case "splash": return .connecting("")
        case "checking": phase = .connecting(target: .primaryAgent)
        case "setup": phase = .live(status: .connecting)
        case "finalizing": phase = .live(status: .connected)
        default: break
        }
        #endif
        return switch phase {
        case nil: .connecting("")
        case .connecting: .connecting("Checking connection")
        case .live(.connected): .connecting("Finalizing")
        case .live: .connecting("Downloading threads")
        case let .failed(message, detail, _): .failed(message: message, detail: detail)
        default: nil
        }
    }

    init(scope: String = "", deferOrbit: Bool = false, publications: InboxPublications = InboxPublications()) {
        self.publications = publications
        self.scope = scope
        let arguments = ProcessInfo.processInfo.arguments
        if scope.isEmpty && arguments.contains("--reset-session") {
            for key in UserDefaults.standard.dictionaryRepresentation().keys where key.hasPrefix("workspace.route.") {
                UserDefaults.standard.removeObject(forKey: key)
            }
            UserDefaults.standard.removeObject(forKey: "workspace.selectedTab")
            clearLinkedSessions()
            KeychainStore.clearSession(scope: scope)
            try? FileManager.default.removeItem(at: Self.cacheDirectory(scope))
        }
        var gatewayURL: String?
        #if DEBUG && targetEnvironment(simulator)
        gatewayURL = ProcessInfo.processInfo.environment["CONN_TEST_TASK_GATEWAY"]
        if arguments.contains("--test-unreachable-gateway") { gatewayURL = "https://127.0.0.1:1" }
        #endif
        perfMark(stage: "swift.store_session_new")
        do {
            session = try ConnSession(
                gatewayUrl: gatewayURL,
                cacheDirectory: Self.cacheDirectory(scope).path,
                listener: SessionBridge(store: self, scope: scope)
            )
        } catch {
            lastError = error.localizedDescription
        }
        let saved = KeychainStore.loadSession(scope: scope).map {
            FfiSavedSession(
                serverUrl: $0.serverURL,
                bearer: $0.bearerToken,
                orbitServerId: $0.orbitServerId,
                environmentId: $0.environmentId
            )
        }
        fleetID = saved?.orbitServerId
        if scope.isEmpty {
            guard !arguments.contains("--manual-pairing") else { return }
            session?.launch(saved: saved)
            linkedOrder = UserDefaults.standard.stringArray(forKey: "linkedSessions") ?? []
            for id in linkedOrder where KeychainStore.loadSession(scope: id) != nil {
                linked[id] = CoreStore(scope: id, deferOrbit: true, publications: publications)
            }
        } else {
            // A saved linked machine reconnects at once with its saved credentials, beside the
            // primary and inside the launch grace window. It used to sit suspended until the
            // primary connected and discovery woke it, which showed "Not connected" and blocked
            // sending in its threads for a long while after every cold launch. Discovery still
            // suspends machines Orbit no longer lists or that are asleep.
            session?.restore(saved: saved)
        }
        coldLaunchSession = saved
        if scope.isEmpty { openRestoredThread() }
    }

    /// Opens the thread the workspace will restore (its saved route) at launch, before any view
    /// exists, so its rows are in place when the thread view appears instead of arriving after
    /// the push while the main thread is busy. The view's own `openThread` then finds it open.
    private func openRestoredThread() {
        guard let environment = environmentId, pendingLink == nil,
              let data = UserDefaults.standard.data(forKey: "workspace.route." + environment),
              let route = try? JSONDecoder().decode(WorkspaceRoute.self, from: data),
              case let .thread(threadId, scope: routeScope) = route, routeScope.isEmpty else { return }
        openThread(threadId)
    }

    func discoverLinked() async {
        guard scope.isEmpty, !discovering, let session, status == .connected, let primary = environmentId else { return }
        let generation = identityEpoch
        discovering = true
        defer { discovering = false }
        let savedScopes = UserDefaults.standard.stringArray(forKey: "linkedSessions") ?? []
        let credentials = Dictionary(uniqueKeysWithValues: Set(savedScopes).compactMap { key in
            KeychainStore.loadSession(scope: key).map { (key, $0) }
        })
        let saved = credentials.values.compactMap(\.orbitServerId)
        let disabled = UserDefaults.standard.stringArray(forKey: "disabledOrbitLinks") ?? []
        let previousLinks = linked
        do {
            let discovery = try await session.linkedNodes(primaryId: primary, saved: saved, disabled: disabled)
            guard !Task.isCancelled, generation == identityEpoch, environmentId == primary else { return }
            let targets = discovery.targets
            discoveryError = discovery.unresolvedEndpoints.isEmpty ? nil :
                "Could not verify the server identity at " + discovery.unresolvedEndpoints.joined(separator: ", ")
            discoveredPrimary = primary
            let wanted = Set(targets.map(\.serverId))
            let unresolved = Set(discovery.unresolvedServerIds)
            for (key, child) in previousLinks {
                guard linked[key] === child, let id = child.fleetID, !wanted.contains(id) else { continue }
                if unresolved.contains(id) {
                    child.suspendFleetSession()
                } else {
                    forgetLinked(key)
                }
            }
            for target in targets {
                let id = target.serverId
                let existing = linked.values.first { $0.fleetID == id || $0.environmentId == id }
                if let existing, existing.fleetID == nil { continue }
                let key = existing?.scope ?? credentials.first { $0.value.orbitServerId == id }?.key ?? UUID().uuidString
                let child = existing ?? CoreStore(scope: key, deferOrbit: true, publications: publications)
                child.fleetID = id
                child.fleetLabel = target.displayTitle
                registerLinked(child)
                guard target.isAwake else {
                    child.suspendFleetSession()
                    continue
                }
                // Already live or connecting from launch (restore): leave that attempt alone.
                switch child.state?.phase {
                case .live?, .connecting?:
                    if child.lastFleetAttempt == nil { child.lastFleetAttempt = Date() }
                    continue
                default: break
                }
                if let attempt = child.lastFleetAttempt {
                    guard child.showsOffline, Date().timeIntervalSince(attempt) >= 300 else { continue }
                }
                child.lastFleetAttempt = Date()
                let credential = credentials[key].map {
                    FfiSavedSession(serverUrl: $0.serverURL, bearer: $0.bearerToken, orbitServerId: $0.orbitServerId, environmentId: $0.environmentId)
                }
                child.session?.followEnvironment(environmentId: id, saved: credential)
            }
        } catch {
            if !Task.isCancelled && environmentId == primary { discoveryError = connectionMessage(error) }
        }
    }

    private func suspendFleetSession() {
        lastFleetAttempt = nil
        guard let session, session.state().phase != .suspended else { return }
        session.suspend()
    }

    private static func cacheDirectory(_ scope: String) -> URL {
        URL.applicationSupportDirectory.appending(path: scope.isEmpty ? "thread-cache" : "thread-cache-" + scope)
    }

    func connectThroughOrbit() {
        lastError = nil
        session?.connectPrimaryAgent()
    }

    /// "Try again" on the Orbit screen: repeats the failed attempt's target.
    func retry() {
        session?.retry()
    }

    func showManualPairing() {
        discardComposerDrafts()
        session?.connectManually()
    }

    func connectWithPairingURL(_ raw: String) {
        lastError = nil
        do {
            let parsed = try PairingURLParser.parse(raw)
            discardComposerDrafts()
            session?.pairManual(serverUrl: parsed.serverURL, pairingCode: parsed.pairingCode)
        } catch {
            lastError = error.localizedDescription
        }
    }

    func assetURL(id: String, name: String, mime: String, mcp: Bool = false) async throws -> URL {
        guard let core, status == .connected else { throw URLError(.notConnectedToInternet) }
        let epoch = identityEpoch
        let raw = try await core.attachmentUrl(id: id, name: name, mime: mime, mcpApp: mcp)
        guard identityEpoch == epoch, let url = URL(string: raw) else { throw URLError(.cancelled) }
        return url
    }

    func mcpApp(thread: String, item: String, attachment: String) async throws -> ThreadMcpApp {
        guard let core, status == .connected else { throw URLError(.notConnectedToInternet) }
        return try await core.threadMcpApp(thread: thread, item: item, attachment: attachment)
    }

    func patches(thread: String, turn: Int64) async throws -> [FfiFilePatch] {
        guard let core, status == .connected else { throw URLError(.notConnectedToInternet) }
        return try await core.turnPatch(threadId: thread, turn: turn)
    }

    func setupFeed(thread: String) throws -> WorktreeSetupFeed {
        guard let core, status == .connected else { throw URLError(.notConnectedToInternet) }
        return try core.worktreeSetup(threadId: thread)
    }

    func openThread(_ threadId: String) {
        perfMark(stage: "swift.open_thread_call")
        if openThreadId != threadId { openThread = nil }
        Self.openLog.info("open thread=\(threadId, privacy: .public)")
        firstSnapshotLog = threadId
        openThreadId = threadId
        // The session closes the scope's other thread, and subscribes this one now or as soon as
        // a connection attaches.
        session?.openThread(threadId: threadId)
    }

    /// Older rows above the open thread; its next snapshot carries them.
    func loadEarlier(threadId: String) {
        core?.loadEarlier(threadId: threadId)
    }

    func closeThread(_ threadId: String) {
        if openThreadId == threadId {
            openThreadId = nil
            openThread = nil
        }
        session?.closeThread(threadId: threadId)
    }

    /// A reply leaves the composer at once: the core shows it as a pending row keyed by the draft's
    /// idempotency key, and the field is free for the next message. A failed reply comes back into
    /// the draft after anything typed since. A new thread keeps its draft until it launches.
    func submit(_ draft: ComposerDraft, for draftKey: ComposerDraftKey, to target: FfiComposerTarget) async -> String? {
        guard status == .connected, let core, drafts[draftKey] === draft, draft.hasContent, !draft.locked else { return nil }
        draft.error = nil
        let epoch = identityEpoch
        let key = draft.key
        let sentText = draft.text
        let sentFiles = draft.files
        let text = sentText.trimmingCharacters(in: .whitespacesAndNewlines)
        let files = sentFiles.map(\.ffi)
        let reply: Bool = if case .reply = target { true } else { false }
        let uploads = sentFiles.indices.map { "pending:\(key):\($0)" }
        if reply {
            for (id, file) in zip(uploads, sentFiles) { pendingUploads[id] = file }
            draft.text = ""
            draft.files = []
        } else {
            draft.sending = true
        }
        defer {
            for id in uploads { pendingUploads[id] = nil }
            if !reply { draft.sending = false }
        }
        do {
            let id = try await core.submitComposer(target: target, key: key, text: text, files: files)
            guard epoch == identityEpoch, drafts[draftKey] === draft else { return nil }
            if !reply, draft.key == key {
                draft.text = ""
                draft.files = []
            }
            if case .new = draftKey { drafts[draftKey] = nil }
            PushRegistration.shared.noteThreadActivity()
            return id
        } catch {
            guard epoch == identityEpoch, drafts[draftKey] === draft else { return nil }
            if reply { draft.restore(text: sentText, files: sentFiles, key: key) }
            draft.error = connectionMessage(error)
            return nil
        }
    }

    /// The composer's model chip and the thread settings sheet's model list.
    func modelPicker(
        threadId: String,
        query: String = "",
        toggled: [String] = [],
        pending: (instanceId: String, model: String)? = nil
    ) async -> FfiModelPicker? {
        guard let core else { return nil }
        return await core.modelPicker(
            threadId: threadId,
            query: query,
            toggled: toggled,
            pendingInstanceId: pending?.instanceId,
            pendingModel: pending?.model
        )
    }

    /// Save in the thread settings sheet. `.unavailable` means the catalog dropped the pick and
    /// nothing was sent; `nil` means the send failed (see `lastError`).
    func saveThreadModel(threadId: String, instanceId: String, model: String, changes: [String: String]) async -> FfiModelSave? {
        guard let core else { return nil }
        do {
            return try await core.saveThreadModelOptions(threadId: threadId, instanceId: instanceId, model: model, changes: changes)
        } catch {
            lastError = error.localizedDescription
            return nil
        }
    }

    /// Asks the server once for the models of the thread's provider in the thread's cwd.
    /// Keeps the thread's workspace models fresh while the picker is open; the core decides
    /// whether to scan. Returns milliseconds until it wants to be asked again, if ever.
    func scanThreadWorkspaceModels(threadId: String) async -> UInt64? {
        guard let core else { return nil }
        return (try? await core.scanThreadWorkspaceModels(threadId: threadId)) ?? nil
    }

    func followUpSteers(_ threadId: String) -> Bool {
        UserDefaults.standard.bool(forKey: "steer.\(environmentId ?? scope).\(threadId)")
    }

    func setFollowUpSteers(_ steer: Bool, threadId: String) {
        UserDefaults.standard.set(steer, forKey: "steer.\(environmentId ?? scope).\(threadId)")
    }

    func stopThread(threadId: String) async {
        guard status == .connected, let core else { return }
        do {
            try await core.stopThread(threadId: threadId)
        } catch {
            lastError = error.localizedDescription
        }
    }

    /// Queued runs shown hidden or with new text while their action is on its way, by run id.
    private(set) var queuedOverrides: [String: QueuedOverride] = [:]
    /// Queued runs whose Send now or Remove is on its way.
    private(set) var queuedBusy: Set<String> = []

    /// Send now: steers the running turn, or starts the queued run when the thread is idle.
    /// The core picks, as desktop does. A failure shows under the composer.
    func sendQueuedNow(threadId: String, runId: String) async {
        guard status == .connected, let core, !queuedBusy.contains(runId) else { return }
        queuedBusy.insert(runId)
        defer { queuedBusy.remove(runId) }
        do {
            try await core.sendQueuedNow(threadId: threadId, runId: runId)
        } catch {
            composerDraft(.thread(threadId)).error = "Send now failed: " + connectionMessage(error)
        }
    }

    /// Remove: the row goes at once and comes back if the server refuses.
    func removeQueuedMessage(threadId: String, runId: String) async {
        guard status == .connected, let core, !queuedBusy.contains(runId) else { return }
        let draft = composerDraft(.thread(threadId))
        if draft.queuedEdit?.runId == runId { draft.cancelQueuedEdit() }
        queuedBusy.insert(runId)
        queuedOverrides[runId] = .removed
        defer { queuedBusy.remove(runId) }
        do {
            try await core.cancelQueuedMessage(threadId: threadId, runId: runId)
        } catch {
            queuedOverrides[runId] = nil
            draft.error = "Could not remove queued message: " + connectionMessage(error)
        }
    }

    /// Save in queued edit mode (desktop `submit` while `editing_queued`): the earlier draft comes
    /// back at once and the row shows the new text. If the server refuses, the row shows its old
    /// text again and, unless something new was typed, the edit reopens with what was written.
    func saveQueuedEdit(threadId: String) async {
        let draft = composerDraft(.thread(threadId))
        guard status == .connected, let core, let edit = draft.queuedEdit, !draft.locked else { return }
        let text = draft.text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !text.isEmpty else { return }
        let newFiles = draft.files
        let kept = edit.keptAttachmentIds
        draft.error = nil
        draft.queuedEdit = nil
        draft.text = edit.savedText
        draft.files = edit.savedFiles
        queuedOverrides[edit.runId] = .edited(text)
        do {
            try await core.editQueuedMessage(
                threadId: threadId, runId: edit.runId, text: text, keptAttachmentIds: kept,
                files: newFiles.map(\.ffi))
        } catch {
            queuedOverrides[edit.runId] = nil
            if draft.queuedEdit == nil, draft.text == edit.savedText {
                draft.queuedEdit = edit
                draft.text = text
                draft.files = newFiles
            }
            draft.error = "Could not update queued message: " + connectionMessage(error)
        }
    }

    /// Drops the overrides the server's queue now agrees with: a removed run gone, an edited run
    /// gone or showing its new text.
    func settleQueuedOverrides(_ queue: [QueuedMessage]) {
        let texts = Dictionary(queue.map { ($0.runId, $0.text) }, uniquingKeysWith: { first, _ in first })
        for (runId, override) in queuedOverrides {
            switch override {
            case .removed where texts[runId] == nil: queuedOverrides[runId] = nil
            case let .edited(text) where texts[runId] == nil || texts[runId] == text: queuedOverrides[runId] = nil
            default: break
            }
        }
    }

    func respondApproval(threadId: String, requestId: String, decision: FfiApprovalDecision) async {
        guard status == .connected, let core else { return }
        do {
            try await core.respondApproval(threadId: threadId, requestId: requestId, decision: decision)
        } catch {
            lastError = error.localizedDescription
        }
    }

    func respondUserInput(threadId: String, requestId: String, answers: [FfiUserInputSubmission]) async {
        guard status == .connected, let core else { return }
        do {
            try await core.respondUserInput(threadId: threadId, requestId: requestId, answers: answers)
        } catch {
            lastError = error.localizedDescription
        }
    }

    func dismissUserInput(threadId: String, requestId: String) async {
        guard status == .connected, let core else { return }
        do {
            try await core.dismissUserInput(threadId: threadId, requestId: requestId)
        } catch {
            lastError = error.localizedDescription
        }
    }

    func answerSecretRequest(threadId: String, turnItemId: String, secret: String?) async {
        guard status == .connected, let core else { return }
        do {
            try await core.answerSecretRequest(threadId: threadId, turnItemId: turnItemId, secret: secret)
        } catch {
            lastError = error.localizedDescription
        }
    }

    func settleThread(threadId: String, settled: Bool) async {
        guard status == .connected, let core else { return }
        do {
            try await core.settleThread(threadId: threadId, settled: settled)
        } catch {
            lastError = error.localizedDescription
        }
    }

    func pinThread(threadId: String, pinned: Bool) async {
        guard status == .connected, let core else { return }
        do {
            try await core.pinThread(threadId: threadId, pinned: pinned)
        } catch {
            lastError = error.localizedDescription
        }
    }

    /// What the thread details sheet lists (the core's `thread_details`).
    func threadDetails(threadId: String) async -> FfiThreadDetails? {
        guard let core else { return nil }
        return await core.threadDetails(threadId: threadId)
    }

    /// The Git facts of a folder for the details sheet (`vcs.refreshStatus`, local only).
    func vcsStatus(cwd: String) async throws -> FfiVcsSummary? {
        guard status == .connected, let core else { return nil }
        return try await core.vcsStatus(cwd: cwd)
    }

    /// "Initialize Git" (`vcs.init`), as desktop's details card does.
    func initGit(cwd: String) async throws {
        guard status == .connected, let core else { throw URLError(.notConnectedToInternet) }
        try await core.initGit(cwd: cwd)
    }

    func renameThread(threadId: String, title: String) async {
        let trimmed = title.trimmingCharacters(in: .whitespacesAndNewlines)
        guard status == .connected, !trimmed.isEmpty, let core else { return }
        do {
            try await core.renameThread(threadId: threadId, title: trimmed)
        } catch {
            lastError = error.localizedDescription
        }
    }

    func deleteThread(threadId: String) async {
        guard status == .connected, let core else { return }
        do {
            try await core.deleteThread(threadId: threadId)
            // `useThreadListActions`: a deleted thread's draft goes with it.
            drafts[.thread(threadId)] = nil
        } catch {
            lastError = error.localizedDescription
        }
    }

    func markThreadUnread(threadId: String) async {
        guard status == .connected, let core else { return }
        do {
            try await core.markThreadUnread(threadId: threadId)
        } catch {
            lastError = error.localizedDescription
        }
    }

    func addLinked(_ raw: String) {
        do {
            let parsed = try PairingURLParser.parse(raw)
            guard !([self] + Array(linked.values)).contains(where: { $0.serverURL == parsed.serverURL }) else {
                lastError = "This environment is already linked."
                return
            }
            let id = UUID().uuidString
            let child = CoreStore(scope: id, publications: publications)
            child.connectWithPairingURL(raw)
            registerLinked(child)
        } catch { lastError = error.localizedDescription }
    }

    var disabledOrbitLinks: [String] {
        UserDefaults.standard.stringArray(forKey: "disabledOrbitLinks") ?? []
    }

    func enableOrbitLink(_ id: String) {
        UserDefaults.standard.set(disabledOrbitLinks.filter { $0 != id }, forKey: "disabledOrbitLinks")
        Task { await discoverLinked() }
    }

    func removeLinked(_ id: String) {
        if let orbit = linked[id]?.fleetID {
            let disabled = UserDefaults.standard.stringArray(forKey: "disabledOrbitLinks") ?? []
            UserDefaults.standard.set(Array(Set(disabled + [orbit])), forKey: "disabledOrbitLinks")
        }
        forgetLinked(id)
    }

    private func forgetLinked(_ id: String) {
        linked.removeValue(forKey: id)?.disconnect()
        linkedOrder.removeAll { $0 == id }
        UserDefaults.standard.set(linkedOrder, forKey: "linkedSessions")
    }

    private func clearLinkedSessions() {
        for id in UserDefaults.standard.stringArray(forKey: "linkedSessions") ?? [] {
            if let child = linked.removeValue(forKey: id) {
                child.disconnect()
            } else {
                KeychainStore.clearSession(scope: id)
                try? FileManager.default.removeItem(at: Self.cacheDirectory(id))
            }
        }
        linked.removeAll()
        linkedOrder.removeAll()
        UserDefaults.standard.removeObject(forKey: "linkedSessions")
    }

    func reconnect() {
        session?.retry()
    }

    func disconnect() {
        imageThumbnails.clear()
        discardComposerDrafts()
        coldLaunchSession = nil
        if scope.isEmpty {
            clearLinkedSessions()
            Task { await PushRegistration.shared.unregister() }
        }
        session?.signOut()
        lastError = nil
    }

    func handleScenePhase(_ phase: ScenePhase) {
        perfMark(stage: "swift.scene_\(phase)")
        switch phase {
        case .active: session?.foreground()
        case .background: session?.background()
        default: return
        }
        for child in linked.values { child.handleScenePhase(phase) }
    }

    // MARK: - Thread links (conn://thread/<environment>/<thread> and push taps)

    /// True when that thread, or the inbox, of the connected environment is on screen.
    func isShowing(_ link: ThreadLink) -> Bool {
        if let child = linked.values.first(where: { $0.environmentId == link.environmentId }) {
            return isInboxVisible || child.openThreadId == link.threadId
        }
        guard environmentId == link.environmentId else { return false }
        return openThreadId == link.threadId || isInboxVisible
    }

    /// Opens a thread from a link. Rust decides: this store keeps it only for its already known
    /// environment; any other link opens right away in its environment's own scope.
    func open(_ link: ThreadLink) {
        defer { pendingLink = link }
        if let child = linkedStore(for: link.environmentId) {
            // Tries again if that environment's last attempt failed.
            _ = child.session?.openLink(environmentId: link.environmentId)
            return
        }
        if session?.openLink(environmentId: link.environmentId) == .here { return }
        guard scope.isEmpty else { return }
        let child = CoreStore(scope: link.environmentId, publications: publications)
        child.fleetID = link.environmentId
        registerLinked(child)
        child.session?.connectEnvironment(environmentId: link.environmentId)
    }

    private func linkedStore(for environmentId: String) -> CoreStore? {
        linked[environmentId] ?? linked.values.first { $0.environmentId == environmentId }
    }

    /// Hands the pending link to the workspace once.
    func consumePendingLink() -> ThreadLink? {
        defer { pendingLink = nil }
        return pendingLink
    }

    // MARK: - Session events

    private static let sessionLog = Logger(subsystem: "com.nckrtl.conn.ios", category: "session")
    /// Thread-open timing: the open, its first snapshot and its first frame.
    static let openLog = Logger(subsystem: "com.nckrtl.conn.ios", category: "open")
    /// The opened thread whose first snapshot is not logged yet.
    @ObservationIgnored private var firstSnapshotLog: String?

    private func logFirstSnapshot(_ snapshot: FfiThreadSnapshot, source: String) {
        guard firstSnapshotLog == snapshot.threadId else { return }
        firstSnapshotLog = nil
        let agents = snapshot.entries.filter { if case .subagent = $0 { true } else { false } }.count
        Self.openLog.info("snapshot thread=\(snapshot.threadId, privacy: .public) source=\(source, privacy: .public) entries=\(snapshot.entries.count) subagents=\(agents) synchronized=\(snapshot.synchronized)")
    }

    /// One `.info` line per published state, so a cold start can be read back from the device log.
    /// It names the host only, and strips URLs in error text down to theirs.
    private func logState(_ s: FfiSessionState) {
        func text(_ value: String) -> String {
            let line = value.replacingOccurrences(of: "\\s+", with: " ", options: .regularExpression)
            let hostOnly = line.replacingOccurrences(
                of: "(https?://[^/\\s\"'<>)]+)[^\\s\"'<>)]*", with: "$1/…", options: .regularExpression
            )
            return String(hostOnly.prefix(300))
        }
        var parts = ["scope=\(scope.isEmpty ? "main" : scope)", "rev=\(s.revision)", "conn=\(s.connectionId)"]
        var errors: [String] = []
        switch s.phase {
        case let .idle(message):
            parts.append("phase=idle")
            if let message { errors.append(message) }
        case let .connecting(target):
            let name = switch target {
            case .primaryAgent: "primaryAgent"
            case .environment: "environment"
            case .manual: "manual"
            }
            parts.append("phase=connecting target=\(name)")
        case let .live(status):
            switch status {
            case .connecting: parts.append("phase=live status=connecting")
            case .connected: parts.append("phase=live status=connected")
            case let .reconnecting(attempt): parts.append("phase=live status=reconnecting(\(attempt))")
            case let .failed(message):
                parts.append("phase=live status=failed")
                errors.append(message)
            }
        case let .failed(message, detail, _):
            parts.append("phase=failed")
            errors.append(message)
            if let detail { errors.append(detail) }
        case .suspended:
            parts.append("phase=suspended")
        }
        parts.append("failed_tries=\(s.failedTries)")
        parts.append("start_retries=\(s.startRetries)")
        parts.append("grace=\(s.inGrace ? "on" : "off")")
        parts.append("shows_offline=\(s.showsOffline)")
        if let host = s.serverUrl.flatMap({ URL(string: $0)?.host }) { parts.append("host=\(host)") }
        for (index, error) in errors.enumerated() {
            parts.append("\(index == 0 ? "error" : "detail")=\"\(text(error))\"")
        }
        let line = parts.joined(separator: " ")
        Self.sessionLog.info("\(line, privacy: .public)")
        // The last state changes, shown when the "Not connected" pill is tapped.
        sessionHistory.append(Date().formatted(date: .omitted, time: .standard) + "  " + line)
        if sessionHistory.count > 15 { sessionHistory.removeFirst(sessionHistory.count - 15) }
    }

    func handleState(_ newState: FfiSessionState) {
        if let state, newState.revision <= state.revision { return }
        logState(newState)
        // The open thread stays: the session resubscribes it on the new connection. Only a switch
        // to another server drops it, with that server's inbox.
        let savedIdentity = coldLaunchSession?.environmentId ?? coldLaunchSession?.orbitServerId
        let differentPrimary = savedIdentity != nil && newState.environmentId != nil && newState.environmentId != savedIdentity
        if newState.identityEpoch != state?.identityEpoch ?? 0 || differentPrimary {
            imageThumbnails.clear()
            discardComposerDrafts()
            coldLaunchSession = nil
            shell = nil
            offlineReader = nil
            discoveredPrimary = nil
            hasPrimaryInventory = false
            openThread = nil
            openThreadId = nil
        }
        // The pump may publish its first inventory before the session attaches its core.
        let wasAttached: Bool = if case .live = state?.phase { state?.connectionId == newState.connectionId } else { false }
        state = newState
        if case .live = newState.phase, !wasAttached { handleShell(connectionId: newState.connectionId) }
        if newState.hasConnected { coldLaunchSession = nil }
        switch newState.phase {
        case let .idle(message):
            if let message { lastError = message }
            else {
                shell = nil
                offlineReader = nil
                hasPrimaryInventory = false
                discoveredPrimary = nil
            }
        case let .live(status):
            if status == .connected { lastError = nil }
        default:
            break
        }
        updateWorkspaceVisibility()
        if case .live = newState.phase, let core {
            uploads.use(core, connection: newState.connectionId)
        } else {
            uploads.use(nil, connection: nil)
        }
        if newState.offlineReady, readerConnection != newState.connectionId, let reader = session?.offlineReader() {
            showOffline(reader, connection: newState.connectionId)
        }
    }

    /// The connection's image cache and prompt reader, once its device database is open.
    private func showOffline(_ reader: OfflineReader, connection: UInt64) {
        readerConnection = connection
        offlineReader = reader
        updateWorkspaceVisibility()
    }

    fileprivate func handleShell(connectionId: UInt64) {
        guard session?.state().connectionId == connectionId else { return }
        publications.submit(scope: scope) { [weak self] in
            guard let self, let snapshot = session?.publishedShell(connectionId: connectionId) else { return }
            if shell != snapshot { shell = snapshot }
            updateWorkspaceVisibility()
        }
    }

    fileprivate func handleThread(_ snapshot: FfiThreadSnapshot, connectionId: UInt64) {
        guard session?.state().connectionId == connectionId else { return }
        // An equal snapshot would still re-run every view that reads the thread.
        if openThreadId == snapshot.threadId, openThread == nil { perfMark(stage: "swift.first_open_snapshot") }
        if openThreadId == snapshot.threadId, openThread != snapshot {
            logFirstSnapshot(snapshot, source: "core")
            BodyCount.tick("store.thread")
            openThread = snapshot
        }
    }

    /// The thread's stream reported `thread.deleted` on this store's connection. A thread missing
    /// from the shell is not deleted (older settled threads are left out), so only this and a
    /// successful delete clear a draft.
    fileprivate func handleThreadDeleted(_ threadId: String, connectionId: UInt64) {
        guard session?.state().connectionId == connectionId else { return }
        drafts[.thread(threadId)] = nil
    }

    fileprivate func handleError(_ message: String) {
        lastError = message
    }

    fileprivate func handleProvidersChanged() {
        providersRevision &+= 1
    }
}

/// Stores what Rust hands over in this store's Keychain scope, and hops session events to the
/// main actor.
private final class SessionBridge: SessionListener, @unchecked Sendable {
    private weak var store: CoreStore?
    private let scope: String

    init(store: CoreStore, scope: String) {
        self.store = store
        self.scope = scope
    }

    func onState(state: FfiSessionState) {
        Task { @MainActor [weak store] in store?.handleState(state) }
    }

    func onSave(session: FfiSavedSession?) {
        if let session {
            KeychainStore.saveSession(
                serverURL: session.serverUrl,
                bearerToken: session.bearer,
                orbitServerId: session.orbitServerId,
                environmentId: session.environmentId,
                scope: scope
            )
        } else {
            KeychainStore.clearSession(scope: scope)
        }
    }

    func onShellChanged(connectionId: UInt64) {
        Task { @MainActor [weak store] in store?.handleShell(connectionId: connectionId) }
    }

    func onThread(connectionId: UInt64, snapshot: FfiThreadSnapshot) {
        Task { @MainActor [weak store] in store?.handleThread(snapshot, connectionId: connectionId) }
    }

    func onThreadDeleted(connectionId: UInt64, threadId: String) {
        Task { @MainActor [weak store] in store?.handleThreadDeleted(threadId, connectionId: connectionId) }
    }

    func onError(message: String) {
        Task { @MainActor [weak store] in store?.handleError(message) }
    }


    func onProvidersChanged() {
        Task { @MainActor [weak store] in store?.handleProvidersChanged() }
    }
}

private func connectionMessage(_ error: Error) -> String {
    guard let error = error as? FfiError else { return error.localizedDescription }
    switch error {
    case let .Connection(message), let .Auth(message), let .Rpc(message), let .Orbit(message, _),
         let .InvalidUrl(message), let .InvalidInput(message), let .InvalidTheme(message):
        return message
    case .Closed: return "Connection closed."
    }
}
