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
                .padding(.top, barHeight + 8)
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
                    .font(.system(size: 16))
                    .foregroundStyle(theme.foreground)
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
                        .font(.system(size: 12))
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

// MARK: - TaskRowView (1:1 port of TaskCard in TasksScreen.tsx)

/// A task as a list row: project, number, subtasks, time, machine and the pull request under the title.
struct TaskRowView: View {
    let row: FfiPhoneTaskRow
    let project: String?
    @Environment(\.colorScheme) private var colorScheme

    var body: some View {
        ProjectListRow(project: project, status: StatusDotState(row.dot), title: row.title, titleWeight: row.recede ? .regular : .medium) {
            EmptyView()
        } meta: {
            Text(row.pullRequest == nil ? row.detail : row.detail + " · ")
                .monospacedDigit()
                .lineLimit(1)
                .layoutPriority(-1)
            if let pr = row.pullRequest {
                HStack(spacing: 3) {
                    ThreadGlyph(name: pr.state == .merged ? "merge" : "pull-request", size: 12)
                    Text("#\(pr.number)").monospacedDigit()
                }
                .foregroundStyle(pullRequestColor(pr.state))
                .fixedSize()
            }
        }
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

    @Environment(\.connTheme) private var theme
}

/// The lab's `ProjectListRow`, shared by Tasks and Pull requests: inset 8, padding 12/8/12/4, the
/// project favicon (status dot on its corner) and title on line 1, 13/17 details under the title.
struct ProjectListRow<Trailing: View, Meta: View>: View {
    let project: String?
    let status: StatusDotState
    let title: String
    var titleWeight: Font.Weight = .medium
    @ViewBuilder let trailing: Trailing
    @ViewBuilder let meta: Meta
    @Environment(\.connTheme) private var theme

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            HStack(alignment: .center, spacing: 12) {
                ProjectFaviconView(title: project, size: 20)
                    .overlay(alignment: .topTrailing) {
                        StatusDot(state: status).offset(x: 4, y: -4)
                    }
                Text(title)
                    .font(.system(size: 16, weight: titleWeight))
                    .foregroundStyle(theme.foreground)
                    .lineLimit(1)
                    .frame(maxWidth: .infinity, minHeight: 20, alignment: .leading)
                trailing
            }
            HStack(spacing: 0) { meta }
                .font(.system(size: 13))
                .foregroundStyle(theme.mutedForeground)
                .frame(height: 17)
                .padding(.leading, 32)
        }
        .padding(EdgeInsets(top: 12, leading: 4, bottom: 12, trailing: 8))
        .contentShape(RoundedRectangle(cornerRadius: 12))
        .padding(.horizontal, 8)
        .padding(.bottom, 4)
    }
}

/// The lab's `StatusDot` states and colours.
enum StatusDotState {
    case working, waiting, done, failed, limited, merged

    init(_ dot: FfiTaskDot) {
        switch dot {
        case .working: self = .working
        case .waiting: self = .waiting
        case .done: self = .done
        case .failed: self = .failed
        }
    }

    func color(_ theme: ConnTheme, _ scheme: ColorScheme) -> Color {
        switch self {
        case .working: AdaptiveColor.sky600400.color(scheme)
        case .waiting: theme.mutedForeground
        case .done: AdaptiveColor.emerald600400.color(scheme)
        case .failed: theme.destructive
        case .limited: theme.warning
        case .merged: AdaptiveColor.violet600400.color(scheme)
        }
    }
}

/// A 6pt status dot in a 2pt ring of the screen colour (`StatusDot`).
struct StatusDot: View {
    let state: StatusDotState
    @Environment(\.connTheme) private var theme
    @Environment(\.colorScheme) private var colorScheme

    var body: some View {
        Circle()
            .fill(state.color(theme, colorScheme))
            .frame(width: 6, height: 6)
            .padding(2)
            .background(Circle().fill(theme.background))
            .allowsHitTesting(false)
    }
}

/// A task's status dot (`StatusBadgeDot`).
struct StatusBadgeDot: View {
    let dot: FfiTaskDot

    var body: some View {
        StatusDot(state: StatusDotState(dot))
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

        var label: String {
            switch self {
            case .overview: "Overview"
            case .steps: "Subtasks"
            case .agents: "Agents"
            }
        }

        var icon: String {
            switch self {
            case .overview: "file-text"
            case .steps: "checklist"
            case .agents: "users"
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
        section == .overview ? "Task #\(id)" : section.label
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
            VStack(alignment: .leading, spacing: 0) {
                if let detail {
                    switch section {
                    case .overview:
                        RecordHeading(title: detail.summary.title) {
                            if let workspace = detail.summary.workspace {
                                RecordField(icon: "server", label: "Workspace",
                                            value: [workspace.name, workspace.nodeName].compactMap { $0 }.joined(separator: " · "))
                                if let branch = workspace.branch { RecordField(icon: "branch", label: "Branch", value: branch) }
                            }
                            if let pr = detail.summary.pullRequest, let url = URL(string: pr.url) {
                                Link(destination: url) {
                                    RecordField(icon: "pull-request", label: "Pull request",
                                                value: "#\(pr.number)" + (pr.state.map { " · " + String(describing: $0).capitalized } ?? ""),
                                                link: true)
                                }.buttonStyle(.plain)
                            }
                            if !detail.usageText.isEmpty { RecordField(icon: "clock", label: "Usage", value: detail.usageText) }
                            if detail.metrics.linesAdded != nil || detail.metrics.linesDeleted != nil {
                                RecordFieldRow(icon: "trend-up", label: "Changes") {
                                    RecordLineStats(added: detail.metrics.linesAdded, removed: detail.metrics.linesDeleted)
                                }
                            }
                        }
                        MarkdownView(source: detail.brief, recordStyle: true)
                            .padding(.top, 13)
                    case .steps:
                        if detail.subtasks.isEmpty { RecordMutedText("No subtasks yet.") }
                        ForEach(Array(detail.subtasks.enumerated()), id: \.element.id) { index, step in
                            subtaskRow(step, first: index == 0)
                        }
                    case .agents:
                        if detail.agents.isEmpty { RecordMutedText("No agents assigned.") }
                        ForEach(Array(detail.agents.enumerated()), id: \.element.id) { index, agent in
                            agentRow(agent, in: detail, first: index == 0)
                        }
                    }
                } else if let failure {
                    Text(failure)
                    Button("Try again") { attempt += 1 }
                } else { ProgressView() }
            }
            .font(.system(size: 14))
            .foregroundStyle(theme.foreground)
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(.horizontal, 20).padding(.top, 28).padding(.bottom, 100)
        }
        .background(theme.background)
        .modifier(RecordChrome(title: sectionTitle, subtitle: subtitle,
                               tabs: Section.allCases.map { ($0.label, $0.icon) },
                               selection: section.label) { name in
            section = Section.allCases.first { $0.label == name } ?? .overview
        })
        .task(id: attempt) {
            failure = nil
            do { detail = try await model.detail(for: id) }
            catch { if !Task.isCancelled { failure = error.localizedDescription } }
        }
    }

    /// `SubtasksList`: indicator, title and line stats on one line, the status under the title;
    /// a tap shows the brief and deliverables.
    private func subtaskRow(_ step: FfiTaskSubtask, first: Bool) -> some View {
        VStack(alignment: .leading, spacing: 0) {
            Button {
                if !expanded.insert(step.id).inserted { expanded.remove(step.id) }
            } label: {
                HStack(alignment: .top, spacing: 8) {
                    RecordStatusIndicator(status: subtaskStatus(step.status), iconSize: 17)
                        .frame(width: 18, height: RecordRow.lineHeight)
                    VStack(alignment: .leading, spacing: 0) {
                        HStack(alignment: .top, spacing: 8) {
                            Text(step.title).fontWeight(.medium)
                                .frame(maxWidth: .infinity, alignment: .leading)
                            if step.status == .completed {
                                RecordLineStats(added: step.metrics.linesAdded, removed: step.metrics.linesDeleted)
                            }
                        }
                        .frame(minHeight: RecordRow.lineHeight)
                        Text([step.statusText, step.usageText].compactMap { $0 }.filter { !$0.isEmpty }.joined(separator: " · "))
                            .font(.system(size: 13)).foregroundStyle(theme.mutedForeground)
                            .frame(minHeight: 19.24)
                    }
                }
                .padding(.top, first ? 0 : 8).padding(.bottom, 8)
                .frame(minHeight: 46, alignment: .top)
                .contentShape(Rectangle())
            }.buttonStyle(.plain).accessibilityIdentifier("task.step." + String(step.id))
            if expanded.contains(step.id) {
                VStack(alignment: .leading, spacing: 0) {
                    Text(step.brief)
                        .lineHeight(.exact(points: RecordRow.lineHeight))
                        .padding(.top, 3).padding(.bottom, 8)
                    if !step.deliverables.isEmpty {
                        Text("Deliverables").fontWeight(.semibold).frame(minHeight: RecordRow.lineHeight)
                        ForEach(step.deliverables, id: \.id) { item in
                            HStack(alignment: .firstTextBaseline, spacing: 0) {
                                Text("•").frame(width: 20, alignment: .center)
                                Text(item.description)
                            }.frame(minHeight: RecordRow.lineHeight)
                        }
                    }
                }
                .padding(.leading, 25).padding(.bottom, 10)
            }
        }
    }

    /// `AgentsList`: the provider icon with its status dot, the assignment, role and model.
    private func agentRow(_ agent: FfiTaskAgent, in detail: FfiTaskDetail, first: Bool) -> some View {
        let assignment = detail.subtasks.filter { agent.subtaskIds.contains($0.id) }.map(\.title).joined(separator: ", ")
        return HStack(alignment: .top, spacing: 8) {
            ProviderIcon(driver: agent.driverKind ?? agent.provider, size: 14)
                .overlay(alignment: .topTrailing) {
                    StatusDot(state: agentDot(agent)).offset(x: 4, y: -4)
                }
                .frame(width: 18, height: RecordRow.lineHeight)
            VStack(alignment: .leading, spacing: 0) {
                Text(assignment.isEmpty ? (agent.role == .reviewer ? "Review the pull request" : detail.summary.title) : assignment)
                    .fontWeight(.medium).frame(minHeight: RecordRow.lineHeight)
                Text([String(describing: agent.role).capitalized, agent.model ?? agent.provider].compactMap { $0 }.joined(separator: " · "))
                    .font(.system(size: 13)).foregroundStyle(theme.mutedForeground).frame(minHeight: 19.24)
            }
            Spacer(minLength: 0)
        }
        .padding(.top, first ? 0 : 8).padding(.bottom, 8)
        .frame(minHeight: 46, alignment: .top)
        .accessibilityElement(children: .combine)
        .accessibilityValue(agent.stateText)
    }

    private func subtaskStatus(_ status: FfiSubtaskStatus) -> RecordStatus {
        switch status {
        case .completed: .passed
        case .failed: .failed
        case .running, .reviewing: .running
        case .todo, .reserved, .cancelled, .unknown: .todo
        }
    }

    private func agentDot(_ agent: FfiTaskAgent) -> StatusDotState {
        switch agent.state {
        case .working?: .working
        case .done?: .done
        case .failed?: .failed
        case .idle?, .askingForInput?, .unknown?, nil: .waiting
        }
    }
}

/// Line height of `.ios-detail-row` text: 14pt at 1.48.
enum RecordRow {
    static let lineHeight: CGFloat = 20.72
}

/// The lab's filter button: the `filter` glyph at 19pt in a 44pt glass circle.
struct WorkspaceFilterIcon: View {
    @Environment(\.connTheme) private var theme
    var body: some View {
        // Lab `FilterPopover`: a 44pt glass circle with the 19pt filter glyph.
        ThreadGlyph(name: "filter", size: 19)
            .foregroundStyle(theme.foreground).frame(width: 44, height: 44)
            .glassEffect(.regular.interactive(), in: .circle)
    }
}

private struct RecordMutedText: View {
    let text: String
    @Environment(\.connTheme) private var theme

    init(_ text: String) { self.text = text }

    var body: some View {
        Text(text).foregroundStyle(theme.mutedForeground)
    }
}

/// `RecordHeading`: the fields (14pt apart), 28pt, then the record's title at 17/23.4 medium.
struct RecordHeading<Fields: View>: View {
    let title: String
    @ViewBuilder let fields: Fields

    var body: some View {
        VStack(alignment: .leading, spacing: 14) { fields }
            .padding(.bottom, 28)
        Text(title)
            .font(.system(size: 17, weight: .medium))
            .lineHeight(.exact(points: 23.375))
    }
}

/// `DetailField`: a 15pt muted glyph (2pt down) and a 14/19 value, 10pt apart.
struct RecordFieldRow<Value: View>: View {
    let icon: String
    let label: String
    @ViewBuilder let value: Value
    @Environment(\.connTheme) private var theme

    var body: some View {
        HStack(alignment: .top, spacing: 10) {
            ThreadGlyph(name: icon, size: 15)
                .foregroundStyle(theme.mutedForeground)
                .padding(.top, 2)
            value
                .frame(maxWidth: .infinity, minHeight: 19, alignment: .topLeading)
        }
        .font(.system(size: 14))
        .foregroundStyle(theme.foreground)
        .accessibilityElement(children: .combine)
        .accessibilityLabel(label)
    }
}

struct RecordField: View {
    let icon: String
    let label: String
    let value: String
    /// A link field ends in a 13pt chevron (`ios-detail-link`).
    var link = false

    var body: some View {
        RecordFieldRow(icon: icon, label: label) {
            HStack(spacing: 0) {
                Text(value)
                if link { ThreadGlyph(name: "chevron-right", size: 13) }
            }
        }
        .accessibilityValue(value)
    }
}

/// `ios-detail-diff`: +added in emerald, −removed in the destructive colour, 5pt apart.
struct RecordLineStats: View {
    let added: Double?
    let removed: Double?
    @Environment(\.connTheme) private var theme
    @Environment(\.colorScheme) private var colorScheme

    var body: some View {
        HStack(spacing: 5) {
            if let added { Text("+\(Int(added))").foregroundStyle(AdaptiveColor.emerald700300.color(colorScheme)) }
            if let removed { Text("−\(Int(removed))").foregroundStyle(theme.destructive) }
        }.monospacedDigit()
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
                    VStack(spacing: 0) {
                        Text(title).font(.system(size: 17, weight: .semibold)).frame(height: 22)
                        if let subtitle {
                            Text(subtitle).font(.system(size: 12)).foregroundStyle(theme.mutedForeground).frame(height: 16)
                        }
                    }
                    .foregroundStyle(theme.foreground)
                    .lineLimit(1)
                }
            }
            .safeAreaInset(edge: .bottom, spacing: 0) {
                HStack(spacing: 0) {
                    ForEach(tabs, id: \.0) { name, icon in
                        Button { choose(name) } label: {
                            ThreadGlyph(name: icon, size: 22)
                                .foregroundStyle(name == selection ? theme.foreground : theme.mutedForeground)
                                .frame(maxWidth: .infinity).frame(height: 40)
                                .background { if name == selection { Capsule().fill(theme.foreground.opacity(0.12)) } }
                                .contentShape(Capsule())
                        }.buttonStyle(.plain).accessibilityLabel(name)
                            .accessibilityAddTraits(name == selection ? .isSelected : [])
                    }
                }.padding(4).frame(width: 256).glassEffect(.regular, in: .capsule).padding(.horizontal, 24).offset(y: 4)
            }
    }
}

/// The lab's status indicators for subtasks and checks.
enum RecordStatus {
    case passed, failed, running, queued, todo
}

/// `check-circle` / `error-circle` glyphs, or the 18pt `StatusRing` (spinning while running).
struct RecordStatusIndicator: View {
    let status: RecordStatus
    var iconSize: CGFloat = 18
    /// A failed check is amber; a failed subtask keeps the text colour.
    var failedColor: Color?
    @Environment(\.connTheme) private var theme
    @Environment(\.colorScheme) private var colorScheme

    var body: some View {
        Group {
            switch status {
            case .passed:
                ThreadGlyph(name: "check-circle", size: iconSize)
                    .foregroundStyle(AdaptiveColor.emerald600400.color(colorScheme))
            case .failed:
                ThreadGlyph(name: "error-circle", size: iconSize)
                    .foregroundStyle(failedColor ?? theme.foreground)
            case .running:
                StatusRing(spinning: true).foregroundStyle(AdaptiveColor.sky600400.color(colorScheme))
            case .queued:
                StatusRing(spinning: false).foregroundStyle(theme.mutedForeground)
            case .todo:
                StatusRing(spinning: false).foregroundStyle(theme.mutedForeground).opacity(0.6)
            }
        }
        .frame(width: 18, height: 18)
        .accessibilityLabel(String(describing: status).capitalized)
    }
}

/// The lab's `StatusRing`: an r 8.75 circle with a 2pt stroke in a 24pt box, drawn at 18pt.
struct StatusRing: View {
    let spinning: Bool
    @State private var turned = false
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    var body: some View {
        let scale: CGFloat = 18 / 24
        let circumference = 2 * .pi * 8.75
        Circle()
            .inset(by: (12 - 8.75) * scale)
            .stroke(style: StrokeStyle(lineWidth: 2 * scale, lineCap: .round,
                                       dash: spinning ? [39 * scale, (circumference - 39) * scale] : []))
            .frame(width: 18, height: 18)
            .rotationEffect(.degrees(turned ? 360 : 0))
            .onAppear {
                guard spinning, !reduceMotion else { return }
                withAnimation(.linear(duration: 1).repeatForever(autoreverses: false)) { turned = true }
            }
    }
}
