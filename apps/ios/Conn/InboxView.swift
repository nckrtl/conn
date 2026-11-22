import DesignKit
import SwiftUI

struct InboxView: View {
    @Bindable var store: CoreStore
    @State private var settledExpanded = false

    private struct ProjectGroup: Identifiable {
        let id: String
        let title: String
        let threads: [FfiThreadSummary]
    }

    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(alignment: .leading, spacing: Kit.Space.xl) {
                    if let error = store.lastError, !error.isEmpty {
                        KitNotice(error, icon: .warning, tone: .error) {
                            Button("Retry") {
                                store.reconnect()
                            }
                            .buttonStyle(.kit)
                        }
                    }

                    if let shell = store.shell, shell.synchronized {
                        let activeGroups = groupedActiveThreads(in: shell)
                        let settled = settledThreads(in: shell)

                        if activeGroups.isEmpty && settled.isEmpty {
                            emptyState
                        } else {
                            ForEach(activeGroups) { group in
                                KitGroup(group.title) {
                                    VStack(spacing: 0) {
                                        ForEach(Array(group.threads.enumerated()), id: \.element.id) { index, thread in
                                            if index > 0 {
                                                Divider()
                                                    .overlay(Color.kitSeparator)
                                                    .padding(.leading, Kit.rowInset)
                                            }
                                            NavigationLink(value: thread.id) {
                                                ThreadSummaryRow(thread: thread)
                                            }
                                            .buttonStyle(.plain)
                                            .accessibilityIdentifier("inbox.thread.\(thread.id)")
                                        }
                                    }
                                }
                            }

                            if !settled.isEmpty {
                                KitGroup {
                                    KitDisclosure(isExpanded: $settledExpanded) {
                                        HStack(spacing: Kit.Space.m) {
                                            Text("Settled")
                                                .font(.kitLabel)
                                                .foregroundStyle(.secondary)
                                            Text("\(settled.count)")
                                                .font(.kitDetail)
                                                .foregroundStyle(.tertiary)
                                        }
                                    } content: {
                                        VStack(spacing: 0) {
                                            ForEach(Array(settled.enumerated()), id: \.element.id) { index, thread in
                                                if index > 0 {
                                                    Divider()
                                                        .overlay(Color.kitSeparator)
                                                        .padding(.leading, Kit.rowInset)
                                                }
                                                NavigationLink(value: thread.id) {
                                                    ThreadSummaryRow(thread: thread)
                                                }
                                                .buttonStyle(.plain)
                                                .accessibilityIdentifier("inbox.settledThread.\(thread.id)")
                                            }
                                        }
                                    }
                                }
                            }
                        }
                    } else {
                        loadingState
                    }
                }
                .padding(.horizontal, Kit.contentInset)
                .padding(.top, Kit.Space.l)
                .padding(.bottom, Kit.Space.xxxl)
            }
            .background(Color.kitContent.ignoresSafeArea())
            .navigationTitle("Threads")
            .toolbar {
                ToolbarItem(placement: .topBarLeading) {
                    ConnectionStatusBadge(status: store.status)
                }
                ToolbarItem(placement: .topBarTrailing) {
                    Menu {
                        if let serverURL = store.serverURL {
                            Text(serverURL)
                        }
                        Button {
                            store.reconnect()
                        } label: {
                            Label("Reconnect", systemImage: KitIcon.sync.symbol)
                        }
                        Divider()
                        Button(role: .destructive) {
                            store.disconnect()
                        } label: {
                            Label("Disconnect", systemImage: KitIcon.power.symbol)
                        }
                    } label: {
                        KitIconImage(.more, size: 16)
                            .foregroundStyle(.primary)
                            .frame(width: 32, height: 32)
                            .contentShape(Rectangle())
                    }
                    .accessibilityLabel("Server menu")
                }
            }
            .navigationDestination(for: String.self) { threadId in
                let summary = store.shell?.threads.first(where: { $0.id == threadId })
                ThreadView(
                    store: store,
                    threadId: threadId,
                    title: summary?.title ?? "Thread",
                    branch: summary?.branch
                )
            }
        }
    }

    private var loadingState: some View {
        VStack(spacing: Kit.Space.m) {
            KitStatusIcon(.working, size: 22, label: "Syncing")
            Text("Syncing threads…")
                .font(.kitLabel)
                .foregroundStyle(.secondary)
        }
        .frame(maxWidth: .infinity)
        .padding(.vertical, 64)
    }

    private var emptyState: some View {
        VStack(spacing: Kit.Space.s) {
            Text("No threads yet")
                .font(.kitLabel)
                .foregroundStyle(.secondary)
            Text("Start a thread on your conn-server and it will appear here live.")
                .font(.kitDetail)
                .foregroundStyle(.tertiary)
                .multilineTextAlignment(.center)
        }
        .frame(maxWidth: .infinity)
        .padding(.vertical, 64)
    }

    private func groupedActiveThreads(in shell: FfiShellSnapshot) -> [ProjectGroup] {
        let projectTitles = Dictionary(uniqueKeysWithValues: shell.projects.map { ($0.id, $0.title) })
        let active = shell.threads.filter { !$0.settled && !$0.isSubagent }

        var buckets: [String: [FfiThreadSummary]] = [:]
        var projectOrder: [String] = []
        for thread in active {
            if buckets[thread.projectId] == nil {
                projectOrder.append(thread.projectId)
            }
            buckets[thread.projectId, default: []].append(thread)
        }

        return projectOrder.compactMap { projectId in
            guard let rows = buckets[projectId], !rows.isEmpty else { return nil }
            let sorted = rows.sorted { ($0.updatedAt ?? "") > ($1.updatedAt ?? "") }
            return ProjectGroup(
                id: projectId,
                title: projectTitles[projectId] ?? "Other",
                threads: sorted
            )
        }
    }

    private func settledThreads(in shell: FfiShellSnapshot) -> [FfiThreadSummary] {
        shell.threads
            .filter { $0.settled && !$0.isSubagent }
            .sorted { ($0.updatedAt ?? "") > ($1.updatedAt ?? "") }
    }
}

private struct ThreadSummaryRow: View {
    let thread: FfiThreadSummary

    var body: some View {
        HStack(spacing: Kit.Space.l) {
            activityBadge
                .frame(width: 20, height: 20)

            VStack(alignment: .leading, spacing: Kit.Space.xs) {
                Text(thread.title.isEmpty ? "Untitled thread" : thread.title)
                    .font(.kitBody)
                    .foregroundStyle(.primary)
                    .lineLimit(2)
                    .multilineTextAlignment(.leading)

                HStack(spacing: Kit.Space.m) {
                    if let branch = thread.branch, !branch.isEmpty {
                        Text(branch)
                            .font(.kitDetail.monospaced())
                            .foregroundStyle(.secondary)
                            .lineLimit(1)
                    }
                    if let timestamp = relativeTime(from: thread.updatedAt) {
                        Text(timestamp)
                            .font(.kitDetail)
                            .foregroundStyle(.tertiary)
                            .lineLimit(1)
                    }
                }
            }

            Spacer(minLength: Kit.Space.s)

            KitIconImage(.chevronRight, size: 12)
                .foregroundStyle(.tertiary)
        }
        .padding(.horizontal, Kit.rowInset)
        .padding(.vertical, Kit.Space.l)
        .frame(minHeight: Kit.rowHeight)
        .contentShape(Rectangle())
    }

    @ViewBuilder
    private var activityBadge: some View {
        switch thread.activity {
        case .idle:
            Circle()
                .fill(Color.secondary.opacity(0.35))
                .frame(width: 8, height: 8)
                .accessibilityLabel("Idle")
        case .working:
            KitStatusIcon(.working, size: 16, label: "Working")
        case .needsAttention:
            KitStatusIcon(.warning, size: 16, label: "Needs attention")
        case .failed:
            KitStatusIcon(.error, size: 16, label: "Failed")
        }
    }
}

private struct ConnectionStatusBadge: View {
    let status: FfiConnectionStatus?

    var body: some View {
        HStack(spacing: Kit.Space.s) {
            switch status {
            case .connected:
                Circle()
                    .fill(Color.green)
                    .frame(width: 8, height: 8)
                Text("Connected")
                    .font(.kitDetail)
                    .foregroundStyle(.secondary)
            case .connecting, .none:
                KitStatusIcon(.working, size: 14, label: "Connecting")
                Text("Connecting")
                    .font(.kitDetail)
                    .foregroundStyle(.secondary)
            case let .reconnecting(attempt):
                KitStatusIcon(.working, size: 14, label: "Reconnecting")
                Text("Reconnecting (\(attempt))")
                    .font(.kitDetail)
                    .foregroundStyle(.secondary)
            case .failed:
                KitStatusIcon(.error, size: 14, label: "Disconnected")
                Text("Failed")
                    .font(.kitDetail)
                    .foregroundStyle(Color.kitErrorText)
            }
        }
        .lineLimit(1)
        .fixedSize()
        .padding(.horizontal, Kit.Space.s)
        .accessibilityElement(children: .combine)
    }
}

private func relativeTime(from iso: String?) -> String? {
    guard let iso, !iso.isEmpty else { return nil }
    let fractional = ISO8601DateFormatter()
    fractional.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
    if let date = fractional.date(from: iso) {
        return Kit.ago(date)
    }
    let plain = ISO8601DateFormatter()
    plain.formatOptions = [.withInternetDateTime]
    if let date = plain.date(from: iso) {
        return Kit.ago(date)
    }
    return nil
}
