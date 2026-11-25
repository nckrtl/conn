import Observation
import SwiftUI

// MARK: - TasksModel (port of useOrbitTaskList in orbitTasks.ts)

/// Every Orbit task this device may read. While the Tasks tab is on screen it follows Orbit's
/// realtime notices and reads the list again on each one, like Conn mobile.
/// The rules for lanes, search, rows and errors live in Rust (`conn-ffi` `phone_tasks`).
@MainActor
@Observable
final class TasksModel {
    enum State {
        case loading
        case loaded(FfiPhoneTasks)
        case failed(FfiPhoneNotice)
    }

    private(set) var state: State = .loading
    private(set) var now = Date()
    /// The lane survives leaving the tab, like the other lists' filters.
    var lane: FfiTaskLane = .inProgress

    @ObservationIgnored private var orbit: OrbitCore?
    @ObservationIgnored private var request: UInt64 = 0
    @ObservationIgnored private var hasList = false
    @ObservationIgnored private var listener: TasksListener?
    @ObservationIgnored private var clock: Task<Void, Never>?

    private static let emptyList = FfiPhoneTasks(tasks: [], runningDurationsMs: [:])

    /// The tab for `query`. Before the list arrives the lanes still show, with no tasks.
    func view(query: String) -> FfiPhoneTasksView {
        let list: FfiPhoneTasks
        if case let .loaded(loaded) = state {
            list = loaded
        } else {
            list = Self.emptyList
        }
        return phoneTasksView(
            list: list,
            lane: lane,
            query: query,
            nowMs: Int64(now.timeIntervalSince1970 * 1000)
        )
    }

    var isLoaded: Bool {
        if case .loaded = state { return true }
        return false
    }

    /// The tab came on screen: follow Orbit's notices, read the list and tick the row timers.
    func appear() {
        guard let orbit = orbitCore() else { return }
        let listener = TasksListener(model: self)
        self.listener = listener
        orbit.startRealtime(listener: listener)
        read()
        clock?.cancel()
        clock = Task { [weak self] in
            // Re-renders every 30 s for the minute timers on running rows (`useNow`).
            while !Task.isCancelled {
                try? await Task.sleep(for: .seconds(30))
                self?.now = Date()
            }
        }
    }

    /// The tab left the screen: stop following Orbit until it comes back.
    func disappear() {
        orbit?.stopRealtime()
        listener = nil
        clock?.cancel()
        clock = nil
    }

    func refresh() async {
        await load()
    }

    fileprivate func read() {
        Task { await load() }
    }

    private func load() async {
        guard let orbit = orbitCore() else { return }
        request &+= 1
        let current = request
        do {
            let list = try await orbit.phoneTasks()
            guard current == request else { return }
            hasList = true
            now = Date()
            state = .loaded(list)
        } catch let FfiError.Orbit(_, reason) {
            guard current == request else { return }
            fail(reason)
        } catch {
            guard current == request else { return }
            fail(.unreachable)
        }
    }

    /// A dropped connection keeps the last good list; any other answer replaces it.
    private func fail(_ reason: FfiOrbitErrorReason) {
        if hasList && reason == .unreachable { return }
        state = .failed(phoneTasksErrorText(reason: reason))
    }

    func detail(for id: Int64) async throws -> FfiTaskDetail {
        guard let orbit = orbitCore() else { throw URLError(.cannotConnectToHost) }
        return try await orbit.taskDetail(taskId: id)
    }

    private func orbitCore() -> OrbitCore? {
        if let orbit { return orbit }
        do {
            #if DEBUG && targetEnvironment(simulator)
            let gateway = ProcessInfo.processInfo.environment["CONN_TEST_TASK_GATEWAY"]
            #else
            let gateway: String? = nil
            #endif
            let created = try OrbitCore(gatewayUrl: gateway)
            orbit = created
            return created
        } catch {
            fail(.unreachable)
            return nil
        }
    }
}

/// Orbit's realtime notices, handed to the model on the main actor.
private final class TasksListener: OrbitListener, @unchecked Sendable {
    private weak var model: TasksModel?

    @MainActor
    init(model: TasksModel) {
        self.model = model
    }

    func onTasksChanged(taskId: Int64?) {
        // The list reads again for any change, to one task or to the list (`onInvalidate`).
        Task { @MainActor [weak model] in
            model?.read()
        }
    }

    func onRealtimeStatus(status: FfiTasksLiveStatus) {}

    func onFleetChanged() {}

    func onProfileChanged() {}
}

// MARK: - TasksTabView (1:1 port of TasksScreen.tsx)

struct TasksTabView: View {
    @Bindable var model: TasksModel
    let searchQuery: String
    @Environment(\.connTheme) private var theme

    /// `TasksTopBar` height.
    private let barHeight: CGFloat = 56

    var body: some View {
        let view = model.view(query: searchQuery)
        ZStack(alignment: .top) {
            ScrollView {
                LazyVStack(spacing: 0) {
                    content(view)
                }
                .padding(.top, barHeight + 4)
            }
            .refreshable { await model.refresh() }
            .background(theme.background)
            .scrollEdgeEffectStyle(.soft, for: .top)
            .scrollEdgeEffectHidden(true, for: .bottom)

            TasksTopBar(
                subtitle: model.isLoaded ? view.subtitle : nil,
                lanes: view.lanes,
                onSelectLane: { model.lane = $0 }
            )
            .frame(height: barHeight)
        }
        .onAppear { model.appear() }
        .onDisappear { model.disappear() }
    }

    @ViewBuilder
    private func content(_ view: FfiPhoneTasksView) -> some View {
        switch model.state {
        case .loading:
            ProgressView()
                .padding(.top, 40)
                .accessibilityIdentifier("tasks.loading")
        case let .failed(notice):
            VStack(spacing: 4) {
                Text(notice.title)
                    .font(.system(size: 16, weight: .medium))
                    .foregroundStyle(theme.foreground)
                Text(notice.detail)
                    .font(.system(size: 15))
                    .foregroundStyle(theme.mutedForeground)
            }
            .multilineTextAlignment(.center)
            .frame(maxWidth: .infinity)
            .padding(.horizontal, 32)
            .padding(.vertical, 40)
            .accessibilityElement(children: .combine)
            .accessibilityIdentifier("tasks.error")
        case let .loaded(list):
            let projects = Dictionary(list.tasks.map { ($0.id, $0.project.name) }, uniquingKeysWith: { first, _ in first })
            if let emptyText = view.emptyText {
                Text(emptyText)
                    .font(.system(size: 15))
                    .foregroundStyle(theme.mutedForeground)
                    .multilineTextAlignment(.center)
                    .frame(maxWidth: .infinity)
                    .padding(.horizontal, 32)
                    .padding(.vertical, 40)
                    .accessibilityIdentifier("tasks.empty")
            } else {
                ForEach(view.rows, id: \.id) { row in
                    NavigationLink(value: WorkspaceRoute.task(row.id)) {
                        TaskRowView(row: row, project: projects[row.id])
                    }
                    .buttonStyle(.plain)
                        .padding(.horizontal, 8)
                        .padding(.bottom, 4)
                }
            }
        }
    }
}

/// Conn turns large titles off: the title stays centred in the bar, a status line under it.
private struct TasksTopBar: View {
    let subtitle: String?
    let lanes: [FfiPhoneTaskLane]
    let onSelectLane: (FfiTaskLane) -> Void
    @Environment(\.connTheme) private var theme

    var body: some View {
        HStack(spacing: 0) {
            Color.clear.frame(width: 44)
            VStack(spacing: 0) {
                Text("Tasks")
                    .font(.system(size: 18, weight: .medium))
                    .foregroundStyle(theme.foreground)
                    .frame(height: 20)
                if let subtitle {
                    Text(subtitle)
                        .font(.system(size: 12).monospacedDigit())
                        .foregroundStyle(theme.mutedForeground)
                        .accessibilityIdentifier("tasks.subtitle")
                }
            }
            .lineLimit(1)
            .frame(maxWidth: .infinity)
            .allowsHitTesting(false)

            Menu {
                TaskLaneMenuItems(lanes: lanes, onSelect: onSelectLane)
            } label: {
                WorkspaceFilterIcon()
            }
            .accessibilityLabel("Filter tasks")
            .accessibilityIdentifier("tasks.laneMenu")
        }
        .padding(.horizontal, 16)
    }
}

/// The lanes as menu items: a check on the selected lane, each lane's task count under its name.
struct TaskLaneMenuItems: View {
    let lanes: [FfiPhoneTaskLane]
    let onSelect: (FfiTaskLane) -> Void

    var body: some View {
        ForEach(lanes, id: \.id) { lane in
            Toggle(isOn: Binding(get: { lane.selected }, set: { _ in onSelect(lane.id) })) {
                Text(lane.label)
                Text("\(lane.count)")
            }
        }
    }
}

// MARK: - TaskRowView (1:1 port of TaskRow in TaskRows.tsx)

/// A task as a list row: the project tile (status dot on its corner) and the title on line 1;
/// project, number, subtasks, time, machine and the pull request under the title.
struct TaskRowView: View {
    let row: FfiPhoneTaskRow
    let project: String?
    @Environment(\.connTheme) private var theme
    @Environment(\.colorScheme) private var colorScheme

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            HStack(alignment: .top, spacing: 12) {
                ProjectFaviconView(title: project, size: 20)
                    .overlay(alignment: .topTrailing) {
                        StatusBadgeDot(dot: row.dot)
                            .offset(x: 4, y: -4)
                    }

                Text(row.title)
                    .font(.system(size: 16, weight: row.recede ? .regular : .medium))
                    .foregroundStyle(theme.foreground)
                    .lineLimit(1)
                    .frame(maxWidth: .infinity, minHeight: 20, alignment: .leading)
            }
            HStack(spacing: 0) {
                Text(row.pullRequest == nil ? row.detail : row.detail + " · ")
                    .font(.system(size: 13))
                    .foregroundStyle(theme.mutedForeground)
                    .lineLimit(1)
                    .layoutPriority(-1)
                if let pr = row.pullRequest {
                    HStack(spacing: 3) {
                        ConnIcon(pr.state == .merged ? "arrow.triangle.merge" : "arrow.triangle.pull")
                            .font(.system(size: 12))
                        Text("#\(pr.number)")
                            .font(.system(size: 13).monospacedDigit())
                    }
                    .foregroundStyle(pullRequestColor(pr.state))
                    .fixedSize()
                }
            }
            .padding(.leading, 32)
        }
        .padding(EdgeInsets(top: 12, leading: 4, bottom: 12, trailing: 8))
        .contentShape(RoundedRectangle(cornerRadius: 12))
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(row.accessibilityLabel)
        .accessibilityIdentifier("tasks.row.\(row.id)")
    }

    private func pullRequestColor(_ state: FfiPullRequestState?) -> Color {
        switch state {
        case .merged?: AdaptiveColor.violet600400.color(colorScheme)
        case .closed?: theme.destructive
        case .open?, nil: AdaptiveColor.emerald700300.color(colorScheme)
        }
    }
}

/// A 6pt status dot in a 2pt ring of the screen colour (`StatusBadgeDot`).
struct StatusBadgeDot: View {
    let dot: FfiTaskDot
    @Environment(\.connTheme) private var theme
    @Environment(\.colorScheme) private var colorScheme

    var body: some View {
        Circle()
            .fill(fill)
            .frame(width: 6, height: 6)
            .padding(2)
            .background(Circle().fill(theme.background))
            .allowsHitTesting(false)
    }

    private var fill: Color {
        switch dot {
        case .working: AdaptiveColor.sky600400.color(colorScheme)
        case .waiting: theme.mutedForeground
        case .done: AdaptiveColor.emerald600400.color(colorScheme)
        case .failed: theme.destructive
        }
    }
}

// MARK: - Adaptive colours

/// Conn mobile's `adaptive-*` colours: one Tailwind shade in light mode, a lighter one in dark
/// mode (`generated-uniwind-themes.css`). They do not change with the Conn theme.
enum AdaptiveColor {
    case sky600400
    case emerald600400
    case emerald700300
    case violet600400

    func color(_ scheme: ColorScheme) -> Color {
        let (light, dark): (UInt32, UInt32) = switch self {
        case .sky600400: (0x0084D1, 0x00BCFF)
        case .emerald600400: (0x009966, 0x00D492)
        case .emerald700300: (0x007A55, 0x5EE9B5)
        case .violet600400: (0x7F22FE, 0xA684FF)
        }
        return Color(rgbHex: scheme == .dark ? dark : light)
    }
}

extension Color {
    /// A colour from `0xRRGGBB`.
    init(rgbHex hex: UInt32) {
        self.init(
            red: Double((hex >> 16) & 0xFF) / 255.0,
            green: Double((hex >> 8) & 0xFF) / 255.0,
            blue: Double(hex & 0xFF) / 255.0
        )
    }
}

struct TaskRecordView: View {
    enum Section: String, CaseIterable {
        case overview, steps, agents

        var icon: String {
            switch self {
            case .overview: "doc.text"
            case .steps: "checklist"
            case .agents: "person.2"
            }
        }
    }

    let id: Int64
    let model: TasksModel
    @State private var section = Section.overview
    @State private var detail: FfiTaskDetail?
    @State private var failure: String?
    @State private var attempt = 0
    @Environment(\.connTheme) private var theme

    @State private var expanded = Set<Int64>()

    private var sectionTitle: String {
        switch section {
        case .overview: "Task #\(id)"
        case .steps: "Subtasks"
        case .agents: "Agents"
        }
    }

    private var subtitle: String? {
        guard let detail else { return nil }
        switch section {
        case .steps where !detail.subtasks.isEmpty:
            return "\(detail.summary.subtaskCounts.completed) of \(detail.subtasks.count) completed"
        case .agents where !detail.agents.isEmpty:
            return "\(detail.agents.count) \(detail.agents.count == 1 ? "agent" : "agents") assigned"
        default: return nil
        }
    }

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 14) {
                if let detail {
                    switch section {
                    case .overview:
                        VStack(alignment: .leading, spacing: 14) {
                            if let workspace = detail.summary.workspace {
                                RecordField(icon: "server.rack", label: "Workspace",
                                            value: [workspace.name, workspace.nodeName].compactMap { $0 }.joined(separator: " · "))
                                if let branch = workspace.branch { RecordField(icon: "arrow.triangle.branch", label: "Branch", value: branch) }
                            }
                            if let pr = detail.summary.pullRequest, let url = URL(string: pr.url) {
                                Link(destination: url) {
                                    RecordField(icon: "arrow.triangle.pull", label: "Pull request", value: "#\(pr.number)" + (pr.state.map { " · " + String(describing: $0).capitalized } ?? ""))
                                }.buttonStyle(.plain)
                            }
                            if !detail.usageText.isEmpty { RecordField(icon: "clock", label: "Usage", value: detail.usageText) }
                            if detail.metrics.linesAdded != nil || detail.metrics.linesDeleted != nil {
                                RecordLineStats(added: detail.metrics.linesAdded, removed: detail.metrics.linesDeleted, withIcon: true)
                            }
                        }.padding(.bottom, 14)
                        Text(detail.summary.title).font(.system(size: 17, weight: .medium))
                        MarkdownView(source: detail.brief, recordStyle: true)
                    case .steps:
                        if detail.subtasks.isEmpty { Text("No subtasks yet.").foregroundStyle(.secondary) }
                        ForEach(detail.subtasks, id: \.id) { step in
                            VStack(alignment: .leading, spacing: 6) {
                                Button {
                                    if !expanded.insert(step.id).inserted { expanded.remove(step.id) }
                                } label: {
                                    HStack(alignment: .top, spacing: 8) {
                                        RecordStatusIndicator(status: step.status == .completed ? "Passed" : step.status == .running ? "Running" : step.status == .failed ? "Failed" : "Pending")
                                        VStack(alignment: .leading, spacing: 3) {
                                            Text(step.title).font(.system(size: 14, weight: .medium))
                                            Text([step.statusText, step.usageText].compactMap { $0 }.joined(separator: " · "))
                                                .font(.system(size: 13)).foregroundStyle(.secondary)
                                        }
                                        Spacer(minLength: 0)
                                        if step.status == .completed {
                                            RecordLineStats(added: step.metrics.linesAdded, removed: step.metrics.linesDeleted)
                                        }
                                    }.contentShape(Rectangle())
                                }.buttonStyle(.plain).accessibilityIdentifier("task.step." + String(step.id))
                                if expanded.contains(step.id) {
                                    VStack(alignment: .leading, spacing: 6) {
                                        MarkdownView(source: step.brief)
                                        if !step.deliverables.isEmpty { Text("Deliverables").fontWeight(.medium) }
                                        ForEach(step.deliverables, id: \.id) { Text("• " + $0.description) }
                                    }.padding(.leading, 26)
                                }
                            }
                        }
                    case .agents:
                        if detail.agents.isEmpty { Text("No agents assigned.").foregroundStyle(.secondary) }
                        ForEach(detail.agents, id: \.id) { agent in
                            let assignment = detail.subtasks.filter { agent.subtaskIds.contains($0.id) }.map(\.title).joined(separator: ", ")
                            HStack(alignment: .top, spacing: 8) {
                                ProviderIcon(driver: agent.driverKind ?? agent.provider, size: 14).frame(width: 18)
                                    .overlay(alignment: .bottomTrailing) {
                                        Circle().fill(agent.needsInput ? Color.orange : agent.current ? .green : .secondary)
                                            .frame(width: 6, height: 6)
                                    }
                                VStack(alignment: .leading, spacing: 3) {
                                    Text(assignment.isEmpty ? (agent.role == .reviewer ? "Review the pull request" : detail.summary.title) : assignment).font(.system(size: 14, weight: .medium))
                                    Text([String(describing: agent.role).capitalized, agent.model ?? agent.provider].compactMap { $0 }.joined(separator: " · "))
                                        .font(.system(size: 13)).foregroundStyle(.secondary)
                                }
                            }.accessibilityValue(agent.stateText)
                        }
                    }
                } else if let failure {
                    Text(failure)
                    Button("Try again") { attempt += 1 }
                } else { ProgressView() }
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(.horizontal, 20).padding(.top, 20)
        }
        .background(theme.background)
        .modifier(RecordChrome(title: sectionTitle, subtitle: subtitle,
                               tabs: Section.allCases.map { ($0 == .steps ? "Subtasks" : $0.rawValue.capitalized, $0.icon) },
                               selection: section == .steps ? "Subtasks" : section.rawValue.capitalized) { name in
            section = name == "Subtasks" ? .steps : Section(rawValue: name.lowercased()) ?? .overview
        })
        .task(id: attempt) {
            failure = nil
            do { detail = try await model.detail(for: id) }
            catch { if !Task.isCancelled { failure = error.localizedDescription } }
        }
    }
}

struct WorkspaceFilterIcon: View {
    @Environment(\.connTheme) private var theme
    var body: some View {
        connImage("line.3.horizontal.decrease").resizable().scaledToFit().frame(width: 18, height: 18)
            .foregroundStyle(theme.foreground).frame(width: 44, height: 44)
            .glassEffect(.regular.interactive(), in: .circle)
    }
}

struct RecordField: View {
    let icon: String
    let label: String
    let value: String

    var body: some View {
        HStack(alignment: .top, spacing: 10) {
            ConnIcon(icon).foregroundStyle(.secondary).frame(width: 15)
            Text(value)
        }.font(.system(size: 14)).frame(minHeight: 19, alignment: .top)
            .accessibilityElement(children: .ignore).accessibilityLabel(label).accessibilityValue(value)
    }
}

struct RecordLineStats: View {
    let added: Double?
    let removed: Double?
    var withIcon = false

    var body: some View {
        HStack(spacing: 5) {
            if withIcon { ConnIcon("chart.line.uptrend.xyaxis").foregroundStyle(.secondary).frame(width: 15).padding(.trailing, 5) }
            if let added { Text("+\(Int(added))").foregroundStyle(.green) }
            if let removed { Text("−\(Int(removed))").foregroundStyle(.red) }
        }.font(.system(size: 14)).monospacedDigit()
    }
}

struct RecordChrome: ViewModifier {
    let title: String
    let subtitle: String?
    let tabs: [(String, String)]
    let selection: String
    let choose: (String) -> Void
    @Environment(\.connTheme) private var theme

    func body(content: Content) -> some View {
        content
            .navigationTitle(title).navigationBarTitleDisplayMode(.inline)
            .toolbar(.visible, for: .navigationBar)
            .toolbar(.hidden, for: .bottomBar)
            .toolbar {
                ToolbarItem(placement: .principal) {
                    VStack(spacing: 1) {
                        Text(title).font(.system(size: 17, weight: .medium))
                        if let subtitle { Text(subtitle).font(.system(size: 12)).foregroundStyle(.secondary) }
                    }
                }
            }
            .safeAreaInset(edge: .bottom, spacing: 0) {
                HStack(spacing: 0) {
                    ForEach(tabs, id: \.0) { name, icon in
                        Button { choose(name) } label: {
                            connImage(icon).resizable().scaledToFit().frame(width: 22, height: 22)
                                .foregroundStyle(name == selection ? theme.foreground : theme.mutedForeground)
                                .frame(maxWidth: .infinity).frame(height: 40)
                                .background { if name == selection { Capsule().fill(theme.foreground.opacity(0.12)) } }
                                .contentShape(Capsule())
                        }.buttonStyle(.plain).accessibilityLabel(name)
                            .accessibilityAddTraits(name == selection ? .isSelected : [])
                    }
                }.padding(4).frame(maxWidth: 238).glassEffect(.regular, in: .capsule).padding(.horizontal, 24).offset(y: 4)
            }
    }
}

struct RecordStatusIndicator: View {
    let status: String
    @Environment(\.connTheme) private var theme

    var body: some View {
        Group {
            switch status {
            case "Passed": ConnIcon("checkmark.circle").foregroundStyle(theme.success)
            case "Failed": ConnIcon("exclamationmark.circle").foregroundStyle(theme.destructive)
            default:
                Circle().strokeBorder(status == "Running" ? theme.info : theme.mutedForeground.opacity(0.55),
                                      style: StrokeStyle(lineWidth: 2, lineCap: .round, dash: [1, 3]))
            }
        }.frame(width: 17, height: 17).accessibilityLabel(status)
    }
}
