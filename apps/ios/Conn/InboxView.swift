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
    @State private var pagingOlder = false
    @State private var renameOwner: CoreStore?
    @State private var renamingThread: FfiThreadSummary?
    @State private var renameDraft = ""

    var body: some View {
        Group {
            if store.inboxOwners.contains(where: { $0.shell != nil }) {
                inboxList()
            } else {
                loadingState
            }
        }
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

    private struct ScopedRow: Identifiable {
        let thread: FfiThreadSummary
        let owner: CoreStore
        let project: FfiProject?
        var id: [String] { [owner.scope, thread.id] }
    }

    private func inboxList() -> some View {
        let owners = store.inboxOwners.filter { environmentFilter == nil || $0.scope == environmentFilter }
        let projectChoices = owners.reduce(into: [String: String]()) { choices, owner in
            guard let snapshot = owner.shell else { return }
            for project in snapshot.projects { choices[project.id] = project.title }
            for thread in snapshot.threads {
                if let slug = thread.orbitProjectSlug { choices[thread.sidebarProjectKey] = slug }
            }
        }
        let rows = inboxRows()
        let active = rows.filter { !$0.thread.settled }
        let settled = rows.filter { $0.thread.settled }
        let paged = owners.filter { ($0.shell?.olderSettledCount ?? 0) > 0 }
        let missing = paged.reduce(0) { $0 + Int($1.shell?.olderSettledCount ?? 0) }
        return List {
            ZStack(alignment: .trailing) {
                VStack(spacing: 0) {
                    Text("Threads").font(.system(size: 18, weight: .medium))
                    Text("\(rows.count) threads").font(.caption).foregroundStyle(.secondary)
                        .accessibilityIdentifier("inbox.threadCount")
                }.frame(maxWidth: .infinity)
                Menu {
                    Picker("Environment", selection: $environmentFilter) {
                        Text("All environments").tag(nil as String?)
                        Text(store.serverURL.flatMap { URL(string: $0)?.host } ?? "Local").tag(Optional(""))
                        ForEach(store.linked.keys.sorted(), id: \.self) { scope in
                            Text(store.linked[scope]?.displayName ?? scope).tag(Optional(scope))
                                .accessibilityIdentifier("inbox.environment." + (store.linked[scope]?.fleetID ?? scope))
                        }
                    }
                    .pickerStyle(.inline)
                    Picker("Project", selection: $selectedProjectFilter) {
                        Text("All projects").tag(nil as String?)
                        ForEach(projectChoices.keys.sorted { (projectChoices[$0] ?? $0, $0) < (projectChoices[$1] ?? $1, $1) }, id: \.self) { key in
                            Text(projectChoices[key] ?? key).tag(Optional(key))
                        }
                    }
                    .pickerStyle(.inline)
                } label: {
                    WorkspaceFilterIcon()
                }.accessibilityLabel("Filter threads")
            }.padding(.horizontal, 16).frame(height: 56)
            .listRowInsets(EdgeInsets())
            .listRowSeparator(.hidden)
            .listRowBackground(theme.background)

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
                        HStack(spacing: 6) {
                            Text("Settled (\(settled.count + missing))")
                                .font(.system(size: 13, weight: .medium).monospacedDigit())
                                .foregroundStyle(theme.mutedForeground)
                            Spacer()
                            ConnIcon(settledExpanded ? "chevron.down" : "chevron.right")
                                .font(.system(size: 11, weight: .semibold))
                                .foregroundStyle(theme.mutedForeground)
                        }
                        .padding(.horizontal, 16)
                        .padding(.top, 16)
                        .padding(.bottom, 8)
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
                                guard !pagingOlder else { return }
                                pagingOlder = true
                                Task {
                                    defer { pagingOlder = false }
                                    await withTaskGroup(of: Void.self) { group in
                                        for owner in paged where owner.status == .connected {
                                            group.addTask { await owner.loadOlder() }
                                        }
                                    }
                                }
                            }
                            .disabled(pagingOlder || !paged.contains { $0.status == .connected })
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
        // `HomeScreen` scroll edges: a soft top blur under the status bar, none at the bottom.
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

    private var loadingState: some View {
        VStack(spacing: Kit.Space.m) {
            KitStatusIcon(.working, size: 22, label: "Syncing")
            Text("Syncing threads…")
                .font(.kitDetail)
                .foregroundStyle(theme.mutedForeground)
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
    }

    private var emptyState: some View {
        VStack(spacing: Kit.Space.m) {
            ConnIcon("text.bubble")
                .font(.system(size: 28, weight: .light))
                .foregroundStyle(theme.mutedForeground)
            Text(searchQuery.isEmpty ? "No threads yet" : "No matching threads")
                .font(.system(size: 16, weight: .medium))
                .foregroundStyle(theme.foreground)
            if searchQuery.isEmpty {
                Text("Tap + to start a new thread.")
                    .font(.system(size: 15))
                    .foregroundStyle(theme.mutedForeground)
            }
        }
        .frame(maxWidth: .infinity)
        .padding(.vertical, 80)
    }

    private func inboxRows() -> [ScopedRow] {
        let query = searchQuery.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        var seen = Set<String>()
        var rows: [ScopedRow] = []
        for owner in store.inboxOwners {
            guard let snapshot = owner.shell else { continue }
            seen.formUnion(snapshot.hiddenThreadIds)
            let projects = Dictionary(uniqueKeysWithValues: snapshot.projects.map { ($0.id, $0) })
            for thread in snapshot.threads where seen.insert(thread.id).inserted {
                guard environmentFilter == nil || owner.scope == environmentFilter else { continue }
                guard selectedProjectFilter == nil || thread.sidebarProjectKey == selectedProjectFilter else { continue }
                let project = projects[thread.projectId]
                if !query.isEmpty && ![thread.title, thread.branch, thread.orbitProjectSlug ?? project?.title]
                    .compactMap({ $0 }).contains(where: { $0.lowercased().contains(query) }) { continue }
                rows.append(ScopedRow(thread: thread, owner: owner, project: project))
            }
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

// MARK: - ThreadListFiltersBar (1:1 port of ThreadListFilters.tsx)

// MARK: - ThreadListV2RowView (1:1 port of ThreadListV2Row)

private struct ThreadListV2RowView: View {
    let thread: FfiThreadSummary
    let projectTitle: String?
    let settled: Bool

    @Environment(\.connTheme) private var theme

    /// `thread-list-v2-row-appearance.ts`: a 20pt favicon, 12 to the title, line 2 indented 32.
    private let iconSize: CGFloat = 20
    private let titleGap: CGFloat = 12

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            // Line 1: project favicon with 6pt status dot on top-right + one-line title
            HStack(alignment: .center, spacing: titleGap) {
                ProjectFaviconView(title: projectTitle, size: iconSize)
                    .opacity(settled ? 0.6 : 1)
                    .projectStatusDot(statusDotColor)

                Text(thread.title.isEmpty ? "Untitled thread" : thread.title)
                    .font(.system(size: 16, weight: settled ? .regular : .medium))
                    .foregroundStyle(settled ? theme.mutedForeground : theme.foreground)
                    .lineLimit(1)
                    .truncationMode(.tail)
                    .frame(maxWidth: .infinity, alignment: .leading)

                if thread.pinned {
                    ConnIcon("pin")
                        .font(.system(size: 11))
                        .foregroundStyle(theme.mutedForeground)
                }
            }

            // Line 2: indented provider/agent icon · project · branch · time
            HStack(spacing: 4) {
                Image(systemName: "sparkle")
                    .font(.system(size: 13, weight: .semibold))
                    .foregroundStyle(Color(red: 0.85, green: 0.47, blue: 0.34))
                Text("·")
                    .font(.system(size: 13))
                    .foregroundStyle(theme.mutedForeground)
                Text(subtitleText)
                    .font(.system(size: 13).monospacedDigit())
                    .foregroundStyle(theme.mutedForeground)
                    .lineLimit(1)
                    .truncationMode(.tail)
            }
            .padding(.leading, iconSize + titleGap)

            // Line 3 (failed threads only): the provider's error, as in Expo's ThreadListV2Row
            // (`text-xs` = 13pt, same gap as line 2; a usage limit shows as a warning).
            if let failureMessage = thread.failureMessage {
                Text(failureMessage)
                    .font(.system(size: 13))
                    .foregroundStyle(thread.usageLimited ? theme.warning : theme.destructive)
                    .lineLimit(1)
                    .truncationMode(.tail)
                    .padding(.leading, iconSize + titleGap)
                    .accessibilityIdentifier("inbox.threadFailureMessage")
            }
        }
        // Row: padding 12 top / 8 right / 12 bottom / 4 left, inset 8 from the screen edges.
        .padding(EdgeInsets(top: 12, leading: 4, bottom: 12, trailing: 8))
        .padding(.horizontal, 8)
        .contentShape(Rectangle())
    }

    private var statusDotColor: Color? {
        if settled { return nil }
        switch thread.activity {
        case .working:
            return Color.blue
        case .needsAttention:
            return theme.warning
        case .failed:
            return theme.destructive
        case .idle:
            return theme.success
        }
    }

    private var subtitleText: String {
        var parts: [String] = []
        if let projectTitle, !projectTitle.isEmpty {
            parts.append(projectTitle)
        } else {
            parts.append("No project")
        }
        if let branch = thread.branch, !branch.isEmpty {
            parts.append(branch)
        }
        if let date = parseISODate(from: thread.updatedAt) {
            parts.append(wholeMinuteRelativeTime(from: date))
        }
        return parts.joined(separator: " · ")
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
        if isScratchProjectTitle(title) {
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
                    .font(.system(size: size * (monogram.count == 1 ? 0.6 : 0.51), weight: .bold, design: .monospaced))
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

private func parseISODate(from raw: String?) -> Date? {
    guard let raw, !raw.isEmpty else { return nil }
    let fractional = ISO8601DateFormatter()
    fractional.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
    if let d = fractional.date(from: raw) { return d }
    let plain = ISO8601DateFormatter()
    plain.formatOptions = [.withInternetDateTime]
    return plain.date(from: raw)
}

/// Whole-minute relative time matching Expo's thread row rule ("0m", "23m", "2h", "3d").
private func wholeMinuteRelativeTime(from date: Date) -> String {
    let seconds = max(0, Int(Date().timeIntervalSince(date)))
    let minutes = seconds / 60
    if minutes < 60 { return "\(minutes)m" }
    let hours = minutes / 60
    if hours < 24 { return "\(hours)h" }
    let days = hours / 24
    return "\(days)d"
}

extension View {
    func projectStatusDot(_ color: Color?) -> some View {
        overlay(alignment: .topTrailing) {
            if let color { ProjectStatusDot(color: color) }
        }
    }
}

private struct ProjectStatusDot: View {
    let color: Color
    @Environment(\.connTheme) private var theme
    var body: some View {
        Circle().fill(color).frame(width: 6, height: 6)
            .padding(2).background(theme.background, in: Circle()).offset(x: 4, y: -4)
    }
}
