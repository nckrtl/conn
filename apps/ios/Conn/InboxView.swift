import DesignKit
import SwiftUI

struct InboxView: View {
    @Bindable var store: CoreStore
    let searchQuery: String
    @Binding var selectedProjectFilter: String?
    @Binding var environmentFilter: String?
    @Binding var settledExpanded: Bool
    let onSelectThread: (String, String) -> Void

    @Environment(\.connTheme) private var theme
    @State private var renameOwner: CoreStore?
    @State private var renamingThread: FfiThreadSummary?
    @State private var renameDraft = ""

    var body: some View {
        inboxList()
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .background(theme.background.ignoresSafeArea())
        .alert(
            "Rename Thread",
            isPresented: Binding(
                get: { renamingThread != nil },
                set: { if !$0 { renamingThread = nil } }
            )
        ) {
            TextField("Title", text: $renameDraft)
            Button("Cancel", role: .cancel) {
                renamingThread = nil
            }
            Button("Save") {
                if let target = renamingThread {
                    let newTitle = renameDraft
                    renamingThread = nil
                    Task {
                        await (renameOwner ?? store).renameThread(threadId: target.id, title: newTitle)
                    }
                }
            }
        }
    }

    struct ScopedRow: Identifiable {
        let thread: FfiThreadSummary
        let owner: CoreStore
        let project: FfiProject?
        var id: [String] { [owner.scope, thread.id] }
    }

    private func inboxList() -> some View {
        let owners = Self.owners(store, environmentFilter: environmentFilter)
        let projectChoices = Self.projectChoices(owners)
        let rows = Self.rows(owners: owners, projectFilter: selectedProjectFilter, query: searchQuery)
        let active = rows.filter { !$0.thread.settled }
        let settled = rows.filter { $0.thread.settled }
        let paged = owners.filter { ($0.shell?.olderSettledCount ?? 0) > 0 }
        let missing = paged.reduce(0) { $0 + Int($1.shell?.olderSettledCount ?? 0) }
        // The title, count and filter live in the navigation bar (`WorkspaceRootView.rootHeader`).
        return List {
            if active.isEmpty && settled.isEmpty && missing == 0 {
                if store.discoveredPrimary == store.environmentId && owners.allSatisfy({ $0.shell?.synchronized == true }) && store.discoveryError == nil { emptyState }
            } else {
                ForEach(active) { row in
                    threadRow(row.thread, owner: row.owner, project: row.project, settled: false)
                }
                if !settled.isEmpty || missing > 0 {
                    Button {
                        withAnimation(Kit.Motion.base) {
                            settledExpanded.toggle()
                        }
                    } label: {
                        HStack(spacing: 10) {
                            Text("Settled (\(settled.count + missing))")
                                .font(.system(size: 14, weight: .medium))
                                .frame(height: 19)
                            Rectangle().fill(theme.border).frame(height: 1)
                            ThreadGlyph(name: settledExpanded ? "chevron-down" : "chevron-right", size: 14)
                        }
                        .foregroundStyle(theme.mutedForeground)
                        .padding(.horizontal, 12)
                        .padding(.top, 16)
                        .padding(.bottom, 6)
                        .contentShape(Rectangle())
                    }
                    .buttonStyle(.plain)
                    .listRowInsets(EdgeInsets())
                    .listRowSeparator(.hidden)
                    .listRowBackground(theme.background)
                    .accessibilityIdentifier("inbox.settledHeader")

                    if settledExpanded {
                        ForEach(settled) { row in
                            threadRow(row.thread, owner: row.owner, project: row.project, settled: true)
                        }
                        if !paged.isEmpty {
                            Button("Load older threads") {
                                for owner in paged { owner.loadOlder() }
                            }
                            .disabled(!paged.contains(where: \.canLoadOlder))
                        }
                    }
                }
            }
        }
        .onChange(of: environmentFilter) { _, _ in
            if let key = selectedProjectFilter, projectChoices[key] == nil { selectedProjectFilter = nil }
        }
        .listStyle(.plain)
        .scrollContentBackground(.hidden)
        .background(theme.background)
        // The list runs under the navigation bar, softly blurred there; no edge at the bottom.
        .scrollEdgeEffectStyle(.soft, for: .top)
        .scrollEdgeEffectHidden(true, for: .bottom)
    }

    private func threadRow(_ thread: FfiThreadSummary, owner: CoreStore, project: FfiProject?, settled: Bool) -> some View {
        Button {
            onSelectThread(thread.id, owner.scope)
        } label: {
            ThreadListV2RowView(
                thread: thread,
                projectTitle: thread.orbitProjectSlug ?? project?.title,
                settled: settled
            )
        }
        .buttonStyle(.plain)
        // 4pt between rows.
        .listRowInsets(EdgeInsets(top: 2, leading: 0, bottom: 2, trailing: 0))
        .listRowSeparator(.hidden)
        .listRowBackground(theme.background)
        .accessibilityIdentifier(settled ? "inbox.settledThread.\(thread.id)" : "inbox.thread.\(thread.id)")
        .swipeActions(edge: .trailing, allowsFullSwipe: true) {
            Button {
                Task {
                    await owner.settleThread(threadId: thread.id, settled: !settled)
                }
            } label: {
                Label(settled ? "Un-settle" : "Settle", systemImage: settled ? "arrow.uturn.backward" : "checkmark")
            }
            .tint(settled ? .blue : .green)

            Button(role: .destructive) {
                Task {
                    await owner.deleteThread(threadId: thread.id)
                }
            } label: {
                Label("Delete", systemImage: "trash")
            }
        }
        .swipeActions(edge: .leading, allowsFullSwipe: false) {
            Button {
                Task {
                    await owner.pinThread(threadId: thread.id, pinned: !thread.pinned)
                }
            } label: {
                Label(thread.pinned ? "Unpin" : "Pin", systemImage: thread.pinned ? "pin.slash" : "pin")
            }
            .tint(.orange)

            if !thread.unread {
                Button {
                    Task {
                        await owner.markThreadUnread(threadId: thread.id)
                    }
                } label: {
                    Label("Unread", systemImage: "envelope.badge")
                }
                .tint(.indigo)
            }
        }
        .contextMenu {
            Button {
                Task {
                    await owner.pinThread(threadId: thread.id, pinned: !thread.pinned)
                }
            } label: {
                Label(thread.pinned ? "Unpin" : "Pin", systemImage: thread.pinned ? "pin.slash" : "pin")
            }

            Button {
                Task {
                    await owner.settleThread(threadId: thread.id, settled: !settled)
                }
            } label: {
                Label(settled ? "Un-settle" : "Settle", systemImage: settled ? "arrow.uturn.backward" : "checkmark")
            }

            if !thread.unread {
                Button {
                    Task {
                        await owner.markThreadUnread(threadId: thread.id)
                    }
                } label: {
                    Label("Mark Unread", systemImage: "envelope.badge")
                }
            }

            Button {
                renameOwner = owner
                renameDraft = thread.title
                renamingThread = thread
            } label: {
                Label("Rename", systemImage: "pencil")
            }

            Divider()

            Button(role: .destructive) {
                Task {
                    await owner.deleteThread(threadId: thread.id)
                }
            } label: {
                Label("Delete", systemImage: "trash")
            }
        }
    }

    private var emptyState: some View {
        VStack(spacing: 4) {
            Text(searchQuery.isEmpty ? "No threads yet" : "No matching threads")
                .font(.system(size: 16, weight: .medium))
                .foregroundStyle(theme.foreground)
            if searchQuery.isEmpty {
                Text("Tap + to start a new thread.")
                    .font(.system(size: 15))
                    .foregroundStyle(theme.mutedForeground)
            }
        }
        .multilineTextAlignment(.center)
        .frame(maxWidth: .infinity)
        .padding(.horizontal, 32)
        .padding(.vertical, 40)
        .listRowInsets(EdgeInsets())
        .listRowSeparator(.hidden)
        .listRowBackground(theme.background)
    }

    static func owners(_ store: CoreStore, environmentFilter: String?) -> [CoreStore] {
        store.inboxOwners.filter { environmentFilter == nil || $0.scope == environmentFilter }
    }

    /// The project filter's choices: each project's title, keyed by its sidebar key.
    static func projectChoices(_ owners: [CoreStore]) -> [String: String] {
        owners.reduce(into: [String: String]()) { choices, owner in
            guard let snapshot = owner.shell else { return }
            for project in snapshot.projects { choices[project.id] = project.title }
            let hidden = Set(snapshot.hiddenThreadIds)
            for thread in snapshot.threads where !hidden.contains(thread.id) {
                if let slug = thread.orbitProjectSlug { choices[thread.sidebarProjectKey] = slug }
            }
        }
    }

    static func rows(owners: [CoreStore], projectFilter: String?, query searchQuery: String) -> [ScopedRow] {
        let query = searchQuery.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        var seen = Set<String>()
        var rows: [ScopedRow] = []
        for owner in owners {
            guard let snapshot = owner.shell else { continue }
            let hidden = Set(snapshot.hiddenThreadIds)
            let projects = Dictionary(uniqueKeysWithValues: snapshot.projects.map { ($0.id, $0) })
            for thread in snapshot.threads where seen.insert(thread.id).inserted {
                if query.isEmpty && hidden.contains(thread.id) { continue }
                guard projectFilter == nil || thread.sidebarProjectKey == projectFilter else { continue }
                let project = projects[thread.projectId]
                if !query.isEmpty && ![thread.title, thread.branch, thread.orbitProjectSlug ?? project?.title]
                    .compactMap({ $0 }).contains(where: { $0.lowercased().contains(query) }) { continue }
                rows.append(ScopedRow(thread: thread, owner: owner, project: project))
            }
            seen.formUnion(hidden)
        }
        return rows.sorted {
            let lhs = $0.thread, rhs = $1.thread
            if lhs.orderGroup != rhs.orderGroup { return lhs.orderGroup < rhs.orderGroup }
            if lhs.orderKey != rhs.orderKey { return lhs.orderKey.utf8.lexicographicallyPrecedes(rhs.orderKey.utf8) }
            if lhs.orderTimeMs != rhs.orderTimeMs { return lhs.orderTimeMs > rhs.orderTimeMs }
            return lhs.id.utf8.lexicographicallyPrecedes(rhs.id.utf8)
        }
    }
}

/// The thread list's filter: environments and projects, behind the header's 44pt glass button.
struct InboxFilterMenu: View {
    @Bindable var store: CoreStore
    @Binding var environmentFilter: String?
    @Binding var selectedProjectFilter: String?

    var body: some View {
        let projectChoices = InboxView.projectChoices(InboxView.owners(store, environmentFilter: environmentFilter))
        Menu {
            Picker("Environments", selection: $environmentFilter) {
                Text("All environments").tag(nil as String?)
                Text(store.serverURL.flatMap { URL(string: $0)?.host } ?? "Local").tag(Optional(""))
                ForEach(store.linked.keys.sorted(), id: \.self) { scope in
                    Text(store.linked[scope]?.displayName ?? scope).tag(Optional(scope))
                        .accessibilityIdentifier("inbox.environment." + (store.linked[scope]?.fleetID ?? store.linked[scope]?.environmentId ?? scope))
                }
            }
            .pickerStyle(.inline)
            Picker("Projects", selection: $selectedProjectFilter) {
                Text("All projects").tag(nil as String?)
                ForEach(projectChoices.keys.sorted { (projectChoices[$0] ?? $0, $0) < (projectChoices[$1] ?? $1, $1) }, id: \.self) { key in
                    Text(projectChoices[key] ?? key).tag(Optional(key))
                }
            }
            .pickerStyle(.inline)
        } label: {
            WorkspaceFilterIcon()
        }.accessibilityLabel("Filter threads")
    }
}

// MARK: - ThreadListFiltersBar (1:1 port of ThreadListFilters.tsx)

// MARK: - ThreadListV2RowView (1:1 port of ThreadListV2Row)

private struct ThreadListV2RowView: View {
    let thread: FfiThreadSummary
    let projectTitle: String?
    let settled: Bool

    @Environment(\.connTheme) private var theme

    /// Lab `ProjectListRow`: a 20pt favicon, 12 to the title, line 2 indented 32.
    private let iconSize: CGFloat = 20
    private let titleGap: CGFloat = 12

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            HStack(alignment: .center, spacing: titleGap) {
                ProjectFaviconView(title: projectTitle, size: iconSize)
                    .opacity(settled ? 0.6 : 1)
                    .projectStatusDot(settled ? nil : statusTone)

                Text(thread.title.isEmpty ? "Untitled thread" : thread.title)
                    .font(.system(size: 15, weight: settled ? .regular : .medium))
                    .foregroundStyle(settled ? theme.mutedForeground : theme.foreground)
                    .lineLimit(1)
                    .truncationMode(.tail)
                    .frame(maxWidth: .infinity, minHeight: 20, alignment: .leading)
            }

            // <provider icon> · project · branch · 23m. The icon keeps its size; the text truncates.
            HStack(alignment: .center, spacing: 4) {
                if let provider = metaProvider {
                    ProviderIcon(driver: provider, size: 12)
                }
                Text(metaLine)
                    .font(.system(size: 13))
                    .foregroundStyle(theme.mutedForeground)
                    .lineLimit(1)
                    .truncationMode(.tail)
                    .frame(maxWidth: .infinity, alignment: .leading)
            }
            .frame(minHeight: 17)
                .padding(.leading, iconSize + titleGap)
                .opacity(settled ? 0.6 : 1)
        }
        // Row: padding 12 top / 8 right / 12 bottom / 4 left, inset 8 from the screen edges.
        .padding(EdgeInsets(top: 12, leading: 4, bottom: 12, trailing: 8))
        .padding(.horizontal, 8)
        .contentShape(Rectangle())
    }

    private var statusTone: StatusDotTone {
        if thread.usageLimited { return .limited }
        switch thread.activity {
        case .working: return .working
        case .needsAttention: return .waiting
        case .failed: return .failed
        case .idle: return .done
        }
    }

    /// The thread's provider driver, or nil when it has none (the line then starts at the project).
    private var metaProvider: String? {
        guard let provider = thread.provider?.trimmingCharacters(in: .whitespaces), !provider.isEmpty else { return nil }
        return provider
    }

    /// The lab's line after the icon: project · branch · age, with a leading "·" after the icon.
    private var metaLine: String {
        var parts: [String] = [projectTitle.flatMap { $0.isEmpty ? nil : $0 } ?? "No project"]
        if let branch = thread.branch, !branch.isEmpty { parts.append(branch) }
        if let date = parseISODate(from: thread.updatedAt) { parts.append(wholeMinuteRelativeTime(from: date)) }
        let line = parts.joined(separator: " · ")
        return metaProvider == nil ? line : "· " + line
    }
}

// MARK: - ProjectFaviconView (1:1 port of ProjectFavicon.tsx + projectIdentity.ts)

func isScratchProjectTitle(_ title: String?) -> Bool {
    guard let t = title?.trimmingCharacters(in: .whitespacesAndNewlines).lowercased() else { return true }
    return t.isEmpty || t == "no project" || t == "general" || t == "scratch"
}

struct ProjectFaviconView: View {
    let title: String?
    let size: CGFloat
    @Environment(\.connTheme) private var theme
    @Environment(\.colorScheme) private var colorScheme

    var body: some View {
        if title?.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty ?? true {
            ConnIcon("text.bubble")
                .font(.system(size: size * 0.85))
                .foregroundStyle(theme.mutedForeground)
                .frame(width: size, height: size)
        } else {
            let name = title ?? ""
            let monogram = deriveProjectMonogram(name)
            let accent = deriveProjectColor(name, isDark: colorScheme == .dark)
            ZStack {
                RoundedRectangle(cornerRadius: size * 0.25, style: .continuous)
                    .fill(accent.opacity(0.16))
                Text(monogram)
                    .font(.system(size: size * 0.515, weight: .bold, design: .monospaced))
                    .foregroundStyle(accent)
                    .lineLimit(1)
            }
            .frame(width: size, height: size)
        }
    }
}

private func deriveProjectMonogram(_ projectName: String) -> String {
    let words = projectName
        .precomposedStringWithCompatibilityMapping
        .trimmingCharacters(in: .whitespacesAndNewlines)
        .components(separatedBy: CharacterSet.alphanumerics.inverted)
        .filter { !$0.isEmpty }
    guard let firstWord = words.first else { return "PR" }
    let chars = Array(firstWord)
    let first = chars.first ?? "P"
    let second: Character =
        chars.dropFirst().first(where: { $0.isNumber })
        ?? (words.count > 1 ? words.last?.first : chars.last)
        ?? first
    return String([first, second]).uppercased()
}

private func deriveProjectColor(_ projectName: String, isDark: Bool) -> Color {
    let darkHex: [UInt32] = [
        0x9ca3af, 0xf87171, 0xfb923c, 0xfbbf24, 0xfacc15, 0xa3e635,
        0x4ade80, 0x34d399, 0x2dd4bf, 0x22d3ee, 0x38bdf8, 0x60a5fa,
        0x818cf8, 0xa78bfa, 0xc084fc, 0xe879f9, 0xf472b6, 0xfb7185,
    ]
    let lightHex: [UInt32] = [
        0x4b5563, 0xdc2626, 0xea580c, 0xd97706, 0xca8a04, 0x65a30d,
        0x16a34a, 0x059669, 0x0d9488, 0x0891b2, 0x0284c7, 0x2563eb,
        0x4f46e5, 0x7c3aed, 0x9333ea, 0xc026d3, 0xdb2777, 0xe11d48,
    ]
    let seed = projectName.precomposedStringWithCompatibilityMapping.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
    var index = 0
    for scalar in (seed.isEmpty ? "project" : seed).unicodeScalars {
        index = (index * 31 + Int(scalar.value)) % darkHex.count
    }
    let hex = isDark ? darkHex[index] : lightHex[index]
    return Color(
        .sRGB,
        red: Double((hex >> 16) & 0xFF) / 255.0,
        green: Double((hex >> 8) & 0xFF) / 255.0,
        blue: Double(hex & 0xFF) / 255.0,
        opacity: 1.0
    )
}

func parseISODate(from raw: String?) -> Date? {
    guard let raw, !raw.isEmpty else { return nil }
    let fractional = ISO8601DateFormatter()
    fractional.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
    if let d = fractional.date(from: raw) { return d }
    let plain = ISO8601DateFormatter()
    plain.formatOptions = [.withInternetDateTime]
    return plain.date(from: raw)
}

/// Whole-minute relative time matching Expo's thread row rule ("0m", "23m", "2h", "3d").
func wholeMinuteRelativeTime(from date: Date) -> String {
    let seconds = max(0, Int(Date().timeIntervalSince(date)))
    let minutes = seconds / 60
    if minutes < 60 { return "\(minutes)m" }
    let hours = minutes / 60
    if hours < 24 { return "\(hours)h" }
    let days = hours / 24
    return "\(days)d"
}

/// Lab `StatusDot.css` states: blue working, grey waiting, green done, red failed, amber limited.
enum StatusDotTone {
    case working, waiting, done, failed, limited, merged

    func color(_ theme: ConnTheme, dark: Bool) -> Color {
        switch self {
        case .working: dark ? rgb(0x00BCFF) : rgb(0x0084D1) // sky-400 / sky-600
        case .waiting: theme.mutedForeground // --color-foreground-tertiary
        case .done: dark ? rgb(0x00D492) : rgb(0x009966) // emerald-400 / emerald-600
        case .failed: dark ? rgb(0xFF6467) : rgb(0xC10007) // --color-danger-foreground
        case .limited: dark ? rgb(0xFFB900) : rgb(0xBB4D00) // --color-warning-foreground
        case .merged: dark ? rgb(0xA684FF) : rgb(0x7F22FE) // violet-400 / violet-600
        }
    }
}

private func rgb(_ hex: UInt32) -> Color {
    Color(.sRGB, red: Double((hex >> 16) & 0xFF) / 255, green: Double((hex >> 8) & 0xFF) / 255,
          blue: Double(hex & 0xFF) / 255, opacity: 1)
}

extension View {
    func projectStatusDot(_ tone: StatusDotTone?) -> some View {
        overlay(alignment: .topTrailing) {
            if let tone { ProjectStatusDot(tone: tone) }
        }
    }

    func projectStatusDot(_ color: Color?) -> some View {
        overlay(alignment: .topTrailing) {
            if let color { ProjectStatusDot(fill: color) }
        }
    }
}

/// A 6pt dot in a 2pt ring of the surface colour, hanging 4pt past the icon's top-right corner.
private struct ProjectStatusDot: View {
    var tone: StatusDotTone?
    var fill: Color?
    @Environment(\.connTheme) private var theme
    @Environment(\.colorScheme) private var colorScheme
    var body: some View {
        Circle().fill(fill ?? tone?.color(theme, dark: colorScheme == .dark) ?? theme.mutedForeground)
            .frame(width: 6, height: 6)
            .padding(2).background(theme.background, in: Circle()).offset(x: 4, y: -4)
    }
}
