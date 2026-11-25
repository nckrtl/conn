import DesignKit
import SwiftUI

enum WorkspaceTab: String, Hashable {
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

private enum WorkspaceSelection: Hashable {
    case section(WorkspaceTab)
    case search
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
    @State private var focusOnSearchEntry = false
    @State private var searchQuery = ""
    @State private var selectedProjectFilter: String? = nil
    @State private var environmentFilter: String?
    @State private var settledExpanded = false
    @State private var pullRequests = WorkspacePullRequests()
    @State private var tasks = TasksModel()
    @FocusState private var searchFocused: Bool
    /// The tab content's bottom inset (the top of the system tab bar) and the screen's own bottom inset.
    @State private var tabBarInset: CGFloat = 0
    @State private var screenInset: CGFloat = 0

    /// Lab `.m-wsbar-circle`: a 48pt glass circle with a 20pt glyph in the primary colour.
    private func footerAction(_ glyph: String, label: String, id: String, action: @escaping () -> Void) -> some View {
        Button(action: action) {
            ThreadGlyph(name: glyph, size: 20)
                .foregroundStyle(theme.primary)
                .frame(width: 48, height: 48).contentShape(Circle())
        }.buttonStyle(.plain).glassEffect(.regular.interactive(), in: .circle)
            .accessibilityLabel(label).accessibilityIdentifier(id)
    }

    /// An icon-only tab item from the lab's 24-unit glyphs, drawn at the lab's 22pt.
    private func tabIcon(_ glyph: String, _ title: String) -> some View {
        let size = CGSize(width: 22, height: 22)
        let image = UIImage(named: "thread-" + glyph).map { source in
            UIGraphicsImageRenderer(size: size).image { _ in source.draw(in: CGRect(origin: .zero, size: size)) }
                .withRenderingMode(.alwaysTemplate)
        } ?? UIImage()
        image.accessibilityLabel = title
        return Image(uiImage: image).accessibilityLabel(title)
    }

    var body: some View {
        NavigationStack(path: $navigationPath) {
            TabView(selection: selection) {
                // Lab `WorkspaceBar`: icon-only items, search inside the same pill (no `.search` role,
                // which would split it into its own circle).
                Tab(value: WorkspaceSelection.section(.threads)) { section(.threads) } label: {
                    tabIcon("thread", "Threads")
                }.accessibilityIdentifier("workspace.tab.threads")
                Tab(value: WorkspaceSelection.section(.tasks)) { section(.tasks) } label: {
                    tabIcon("checklist", "Tasks")
                }.accessibilityIdentifier("workspace.tab.tasks")
                Tab(value: WorkspaceSelection.section(.pullRequests)) { section(.pullRequests) } label: {
                    tabIcon("pull-request", "Pull requests")
                }.accessibilityIdentifier("workspace.tab.pullRequests")
                Tab(value: WorkspaceSelection.search) { section(selectedTab, query: searchQuery) } label: {
                    tabIcon("search", "Search")
                }.accessibilityIdentifier("workspace.searchButton")
            }
            .tabViewStyle(.tabBarOnly)
            // Lab: the active tab takes the accent foreground; content keeps the app tint.
            .tint(theme.accentForeground)
            .onGeometryChange(for: CGFloat.self, of: { $0.safeAreaInsets.bottom }) { screenInset = $0 }
            .overlay(alignment: .bottom) {
                // The settings and new-chat circles sit on the tab bar's row, either side of its pill.
                if !isSearching {
                    HStack {
                        footerAction("more-horizontal", label: "Open settings", id: "workspace.settingsButton") { showingSettings = true }
                        Spacer()
                        footerAction("add", label: "New chat", id: "inbox.newThreadButton") {
                            navigationPath.append(.newThreadDraft(projectId: nil, title: "General"))
                        }.disabled(store.showsOffline).opacity(store.showsOffline ? 0.5 : 1)
                    }
                    .padding(.horizontal, 24)
                    .padding(.bottom, max(0, (tabBarInset + screenInset) / 2 - 24))
                    .ignoresSafeArea(edges: .bottom)
                }
            }
            .toolbar(.hidden, for: .navigationBar)
            .toolbar(.hidden, for: .bottomBar)
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
            if isSearching && !path.isEmpty { searchFocused = false }
            guard let environment = restoredEnvironment, environment == store.environmentId else { return }
            let key = "workspace.route." + environment
            guard let route = path.last else { UserDefaults.standard.removeObject(forKey: key); return }
            if case .newThreadDraft = route { return }
            if let data = try? JSONEncoder().encode(route) { UserDefaults.standard.set(data, forKey: key) }
        }
        .onChange(of: selectedTab == .tasks && navigationPath.isEmpty, initial: true) { _, visible in
            if visible { tasks.appear() } else { tasks.disappear() }
        }
        .task(id: selectedTab == .pullRequests && navigationPath.isEmpty ? (store.environmentId ?? "") : nil) {
            guard selectedTab == .pullRequests, navigationPath.isEmpty else { return }
            await pullRequests.load(store: store)
        }
        .onDisappear {
            store.isInboxVisible = false
            tasks.disappear()
        }
        .onChange(of: inboxOnScreen) { _, visible in store.isInboxVisible = visible }
        .onChange(of: store.pendingLink) { _, _ in showPendingLink() }
    }

    private var selection: Binding<WorkspaceSelection> {
        Binding(get: { isSearching ? .search : .section(selectedTab) }, set: { newValue in
            switch newValue {
            case .search:
                guard !isSearching else { return }
                focusOnSearchEntry = true
                isSearching = true
            case let .section(tab):
                searchFocused = false
                selectedTab = tab
                isSearching = false
                searchQuery = ""
            }
        })
    }

    private func section(_ tab: WorkspaceTab, query: String? = nil) -> some View {
        Group {
            switch tab {
            case .threads:
                InboxView(store: store, searchQuery: query ?? "", selectedProjectFilter: $selectedProjectFilter,
                          environmentFilter: $environmentFilter, settledExpanded: $settledExpanded) { threadId, scope in
                    navigationPath.append(.thread(threadId, scope: scope))
                }
            case .tasks: TasksTabView(model: tasks, searchQuery: query ?? "")
            case .pullRequests: PullRequestsTabView(store: store, searchQuery: query ?? "", model: pullRequests)
            }
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .background(theme.background.ignoresSafeArea())
        .tint(theme.primary)
        // Lab: searching swaps the whole bar for the field and a cancel circle.
        .toolbar(query != nil ? .hidden : .visible, for: .tabBar)
        .safeAreaInset(edge: .bottom, spacing: 0) {
            VStack(spacing: 8) {
                if store.showsOffline && !store.showsSavedConnectionAlert { OfflinePill() }
                if query != nil {
                    HStack(spacing: 8) {
                        // Lab `.ios-search-field`: 44pt capsule, 12 inset, 18pt glyph 6 from the text.
                        HStack(spacing: 6) {
                            ThreadGlyph(name: "search", size: 18).foregroundStyle(theme.mutedForeground)
                            TextField(tab.searchPlaceholder, text: $searchQuery)
                                .focused($searchFocused).submitLabel(.search)
                                .foregroundStyle(theme.foreground)
                                .accessibilityIdentifier("workspace.searchField")
                        }
                        .padding(.horizontal, 12).frame(height: 44)
                        .overlay(Capsule().strokeBorder(theme.border, lineWidth: 1))
                        .glassEffect(.regular, in: .capsule)
                        .onAppear {
                            guard focusOnSearchEntry else { return }
                            focusOnSearchEntry = false
                            searchFocused = true
                        }
                        footerAction("close", label: "Cancel search", id: "workspace.cancelSearch") {
                            selection.wrappedValue = .section(selectedTab)
                        }
                    }.padding(.horizontal, 24)
                }
            }.padding(.bottom, query == nil ? 8 : 0)
        }
        .onGeometryChange(for: CGFloat.self, of: { $0.safeAreaInsets.bottom }) { inset in
            if query == nil { tabBarInset = inset }
        }
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

struct OfflinePill: View {
    var body: some View {
        // Lab `OfflinePill`: a 14pt bolt 6 from 13pt medium text.
        HStack(spacing: 6) {
            ThreadGlyph(name: "bolt", size: 14)
            Text("Not connected")
        }
            .font(.system(size: 13, weight: .medium))
            .frame(height: 16)
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
