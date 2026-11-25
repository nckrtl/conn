import DesignKit
import SwiftUI

enum WorkspaceTab: String, Hashable, CaseIterable {
    case threads
    case tasks
    case pullRequests

    var searchPlaceholder: String {
        switch self {
        case .threads: "Search threads"
        case .tasks: "Search tasks"
        case .pullRequests: "Search pull requests"
        }
    }
}

enum WorkspaceRoute: Hashable, Codable {
    case task(Int64)
    case pullRequest(PullRequestRow)
    case thread(String, scope: String)
    case newThreadDraft(projectId: String?, title: String, scope: String = "", prompt: String = "")
}

struct WorkspaceRootView: View {
    @Bindable var store: CoreStore
    @Environment(\.connTheme) private var theme

    @AppStorage("workspace.selectedTab") private var selectedTab: WorkspaceTab = .threads
    @State private var navigationPath: [WorkspaceRoute] = []
    @State private var restoredEnvironment: String?
    @Environment(\.scenePhase) private var scenePhase
    @State private var showingSettings = false
    @State private var isSearching = false
    @State private var searchQuery = ""
    @State private var selectedProjectFilter: String? = nil
    @State private var tasks = TasksModel()
    @FocusState private var searchFocused: Bool

    private func footerAction(_ icon: String, label: String, id: String, action: @escaping () -> Void) -> some View {
        Button(action: action) {
            connImage(icon).resizable().scaledToFit().frame(width: 20, height: 20)
                .frame(width: 48, height: 48).contentShape(Circle())
        }.buttonStyle(.plain).glassEffect(.regular, in: .circle)
            .accessibilityLabel(label).accessibilityIdentifier(id)
    }

    var body: some View {
        NavigationStack(path: $navigationPath) {
            ZStack(alignment: .bottom) {
                Group {
                    switch selectedTab {
                    case .threads:
                        InboxView(
                            store: store,
                            searchQuery: isSearching ? searchQuery : "",
                            selectedProjectFilter: $selectedProjectFilter,
                            onSelectThread: { threadId, scope in
                                if isSearching {
                                    isSearching = false
                                    searchQuery = ""
                                }
                                navigationPath.append(.thread(threadId, scope: scope))
                            }
                        )
                    case .tasks:
                        TasksTabView(
                            model: tasks,
                            searchQuery: isSearching ? searchQuery : ""
                        )
                    case .pullRequests:
                        PullRequestsTabView(
                            store: store,
                            searchQuery: isSearching ? searchQuery : ""
                        )
                    }
                }
                .frame(maxWidth: .infinity, maxHeight: .infinity)
                .background(theme.background.ignoresSafeArea())

                if store.showsOffline {
                    OfflinePill()
                        .padding(.bottom, 12)
                }
            }
            .toolbar(.hidden, for: .navigationBar)
            .toolbar(.hidden, for: .bottomBar)
            .safeAreaInset(edge: .bottom, spacing: 0) {
                HStack(spacing: 8) {
                    if isSearching {
                        HStack(spacing: 8) {
                            ConnIcon("magnifyingglass").foregroundStyle(.secondary)
                            TextField(selectedTab.searchPlaceholder, text: $searchQuery)
                                .focused($searchFocused).submitLabel(.search)
                        }.padding(.horizontal, 16).frame(height: 48).glassEffect(.regular, in: .capsule)
                        footerAction("xmark", label: "Cancel search", id: "workspace.cancelSearch") {
                            isSearching = false
                            searchQuery = ""
                        }
                    } else {
                        footerAction("ellipsis", label: "Open settings", id: "workspace.settingsButton") { showingSettings = true }
                        Spacer(minLength: 0)
                        WorkspacePhoneSwitcher(selectedTab: $selectedTab, onSearch: { isSearching = true })
                            .glassEffect(.regular, in: .capsule)
                        Spacer(minLength: 0)
                        footerAction("plus", label: "New chat", id: "inbox.newThreadButton") {
                            navigationPath.append(.newThreadDraft(projectId: nil, title: "General"))
                        }.disabled(store.showsOffline)
                    }
                }.padding(.horizontal, 24).offset(y: 4)
            }
            .onChange(of: isSearching) { _, value in searchFocused = value }
            .navigationDestination(for: WorkspaceRoute.self) { route in
                switch route {
                case let .task(id):
                    TaskRecordView(id: id, model: tasks)
                case let .pullRequest(row):
                    PullRequestRecord(store: store, row: row)
                case let .thread(threadId, scope):
                    if let owner = scope.isEmpty ? store : store.linked[scope] {
                        let summary = owner.shell?.threads.first(where: { $0.id == threadId })
                        let projectTitle = summary.flatMap { s in
                            owner.shell?.projects.first(where: { $0.id == s.projectId })?.title
                        }
                        ThreadView(
                            store: owner,
                            threadId: threadId,
                            initialTitle: summary?.title ?? "Thread",
                            initialProjectTitle: summary?.orbitProjectSlug ?? projectTitle,
                            initialBranch: summary?.branch,
                            initialSettled: summary?.settled ?? false,
                            onOpenThread: { childId, environment in
                                if let environment, environment != owner.environmentId {
                                    store.open(ThreadLink(environmentId: environment, threadId: childId))
                                } else {
                                    navigationPath.append(.thread(childId, scope: scope))
                                }
                            },
                            onTemplate: { prompt in
                                navigationPath.append(.newThreadDraft(projectId: summary?.projectId, title: projectTitle ?? "General", scope: scope, prompt: prompt))
                            }
                        )
                    }
                case let .newThreadDraft(projectId, title, scope, prompt):
                    if let owner = scope.isEmpty ? store : store.linked[scope] {
                    NewThreadDraftView(
                        store: owner,
                        initialProjectId: projectId,
                        initialProjectTitle: title,
                        initialPrompt: prompt,
                        onCreated: { newThreadId in
                            navigationPath = [.thread(newThreadId, scope: scope)]
                        }
                    )
                    }
                }
            }
        }
        .sheet(isPresented: $showingSettings) {
            SettingsRootSheet(store: store)
                .presentationDetents([.large])
        }
        .onAppear {
            showPendingLink()
            store.isInboxVisible = inboxOnScreen
        }
        .task(id: scenePhase == .active && store.status == .connected ? store.environmentId : nil) {
            guard scenePhase == .active, store.status == .connected else { return }
            while !Task.isCancelled {
                await store.discoverLinked()
                do { try await Task.sleep(for: .seconds(60)) } catch { return }
            }
        }
        .task(id: store.environmentId) {
            guard let environment = store.environmentId, restoredEnvironment != environment else { return }
            let switching = restoredEnvironment != nil
            restoredEnvironment = environment
            if switching { navigationPath = [] }
            guard navigationPath.isEmpty, store.pendingLink == nil,
                  let data = UserDefaults.standard.data(forKey: "workspace.route." + environment),
                  let route = try? JSONDecoder().decode(WorkspaceRoute.self, from: data) else { return }
            if case let .thread(_, scope) = route, !scope.isEmpty && store.linked[scope] == nil { return }
            navigationPath = [route]
        }
        .onChange(of: navigationPath) { _, path in
            guard let environment = restoredEnvironment, environment == store.environmentId else { return }
            let key = "workspace.route." + environment
            guard let route = path.last else { UserDefaults.standard.removeObject(forKey: key); return }
            if case .newThreadDraft = route { return }
            if let data = try? JSONEncoder().encode(route) { UserDefaults.standard.set(data, forKey: key) }
        }
        .onDisappear { store.isInboxVisible = false }
        .onChange(of: inboxOnScreen) { _, visible in store.isInboxVisible = visible }
        .onChange(of: store.pendingLink) { _, _ in showPendingLink() }
    }

    /// The thread list is what the user sees: no thread pushed, no sheet, not searching.
    private var inboxOnScreen: Bool {
        navigationPath.isEmpty && selectedTab == .threads && !showingSettings && !isSearching
    }

    /// Shows a thread from a `conn://thread/...` URL or a push tap.
    private func showPendingLink() {
        guard let link = store.consumePendingLink() else { return }
        showingSettings = false
        isSearching = false
        searchQuery = ""
        selectedTab = .threads
        // An environment opened from a link is keyed by its id before it knows it.
        let scope = store.linked[link.environmentId] != nil
            ? link.environmentId
            : store.linked.first { $0.value.environmentId == link.environmentId }?.key ?? ""
        navigationPath = [.thread(link.threadId, scope: scope)]
    }
}

// MARK: - WorkspacePhoneBar (1:1 port of WorkspacePhoneBar.tsx)

private struct WorkspacePhoneSwitcher: View {
    @Binding var selectedTab: WorkspaceTab
    let onSearch: () -> Void
    @Environment(\.connTheme) private var theme

    var body: some View {
        HStack(spacing: 0) {
            item(.threads, icon: "text.bubble", label: "Threads")
            item(.tasks, icon: "checklist", label: "Tasks")
            item(.pullRequests, icon: "arrow.triangle.pull", label: "Pull requests")
            Button(action: onSearch) {
                toolbarIcon("magnifyingglass")
                    .foregroundStyle(theme.mutedForeground)
                    .frame(maxWidth: .infinity).frame(height: 40)
                    .contentShape(Capsule())
            }
            .buttonStyle(.plain)
            .accessibilityLabel("Search")
            .accessibilityIdentifier("workspace.searchButton")
        }
        .padding(4)
        .frame(maxWidth: 238)
    }

    /// 22pt icons. A bar item lays out from UIImage sizes, so the asset is framed explicitly.
    private func toolbarIcon(_ name: String) -> some View {
        connImage(name)
            .resizable()
            .scaledToFit()
            .frame(width: 22, height: 22)
    }

    private func item(_ tab: WorkspaceTab, icon: String, label: String) -> some View {
        let selected = selectedTab == tab
        return Button {
            selectedTab = tab
        } label: {
            toolbarIcon(icon)
                .foregroundStyle(selected ? theme.foreground : theme.mutedForeground)
                .frame(maxWidth: .infinity).frame(height: 40)
                .background {
                    if selected {
                        Capsule().fill(theme.foreground.opacity(0.12))
                    }
                }
                .contentShape(Capsule())
        }
        .buttonStyle(.plain)
        .accessibilityLabel(label)
        .accessibilityAddTraits(selected ? [.isSelected] : [])
        .accessibilityIdentifier("workspace.tab.\(tab.rawValue)")
    }
}

struct OfflinePill: View {
    var body: some View {
        Label("Not connected", systemImage: "bolt.fill")
            .font(.system(size: 13, weight: .medium))
            .foregroundStyle(Color(red: 0.16, green: 0.14, blue: 0.055))
            .padding(.horizontal, 12)
            .padding(.vertical, 6)
            .background(Color(red: 1, green: 0.83, blue: 0.30), in: Capsule())
    }
}

struct ConnectionStatusPill: View {
    let status: FfiConnectionStatus?

    var body: some View {
        switch status {
        case .connected:
            KitStatusPill("Connected", tone: .ok)
        case .connecting, .none:
            KitStatusPill("Connecting", tone: .working)
        case let .reconnecting(attempt):
            KitStatusPill("Reconnecting (\(attempt))", tone: .working)
        case .failed:
            KitStatusPill("Failed", tone: .error)
        }
    }
}
