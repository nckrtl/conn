import SwiftUI
import UIKit

/// Desktop's thread details card as a sheet (lab `ThreadDetailsSheet`): opens at the medium
/// detent, pulls to large, and pushes "Previous agents" inside its own stack. The rows come from
/// the core's `thread_details` (`conn_state::thread_details`).
struct ThreadDetailsSheet: View {
    let store: CoreStore
    let threadId: String
    /// The machine the thread runs on.
    let machine: String
    let onOutline: () -> Void
    let onOpenPullRequest: (FfiThreadPullRequest) -> Void
    let onOpenAgent: (FfiThreadDetailsAgent) -> Void

    @Environment(\.connTheme) private var theme
    @Environment(\.dismiss) private var dismiss
    @State private var details: FfiThreadDetails?
    @State private var vcs: FfiVcsSummary?
    @State private var initializing = false
    @State private var initError: String?
    @State private var showsAllPullRequests = false
    @State private var copied: String?
    @State private var detent: PresentationDetent = .medium
    @State private var path: [Page] = []

    enum Page: Hashable { case previousAgents }

    /// Linked pull requests shown before "Show N more" (desktop shows one; the phone has room for two).
    static let initialPullRequests = 2

    var body: some View {
        NavigationStack(path: $path) {
            ScrollView {
                VStack(spacing: 24) {
                    if let details { panel(details) }
                }
                .padding(EdgeInsets(top: 6, leading: 16, bottom: 40, trailing: 16))
            }
            .scrollContentBackground(.hidden)
            .background(sheetBackground)
            .navigationTitle("Thread details")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar { closeButton }
            .navigationDestination(for: Page.self) { _ in previousAgents }
        }
        .presentationDetents([.medium, .large], selection: $detent)
        .presentationDragIndicator(.visible)
        .accessibilityIdentifier("thread.details")
        .task(id: refreshKey) { await refresh() }
        .task(id: details?.folder) { await loadVcs() }
        .task(id: hasRunningAgents) {
            // Running agents count their time up, as on desktop.
            while hasRunningAgents, !Task.isCancelled {
                try? await Task.sleep(for: .seconds(1))
                await refresh()
            }
        }
    }

    // MARK: Pages

    @ViewBuilder
    private func panel(_ details: FfiThreadDetails) -> some View {
        DetailsSection {
            DetailsRow(icon: glyph("desktop"), label: machine) {
                if let project = details.projectTitle {
                    HStack(spacing: 6) {
                        ThreadGlyph(name: "folder", size: 18).foregroundStyle(theme.mutedForeground)
                        Text(project).foregroundStyle(theme.foreground)
                    }
                }
            }
            .accessibilityIdentifier("thread.details.machine")
            DetailsButton(id: "thread.details.outline", action: {
                onOutline()
                dismiss()
            }) {
                DetailsRow(icon: glyph("list"), label: "Thread outline")
            }
            if let link = copyLink {
                DetailsButton(id: "thread.details.copyLink", action: { copy("link", link) }) {
                    DetailsRow(icon: glyph("link"), label: "Copy thread link") { copiedMark("link") }
                }
            }
            if let folder = details.folder {
                DetailsButton(id: "thread.details.copyPath", action: { copy("path", folder) }) {
                    DetailsRow(icon: glyph("copy"), label: "Copy folder path") {
                        copiedMark("path") { Text(details.folderLabel ?? folder).truncationMode(.head) }
                    }
                }
            }
        }
        if !details.pullRequests.isEmpty { pullRequests(details.pullRequests) }
        git(details)
        if !details.running.isEmpty || !details.previous.isEmpty {
            DetailsSection(title: details.subagentsTitle) {
                ForEach(details.running, id: \.key) { agent in agentRow(agent) }
                if !details.previous.isEmpty {
                    NavigationLink(value: Page.previousAgents) {
                        DetailsRow(icon: glyph("agent"), label: "Previous agents") {
                            HStack(spacing: 6) {
                                Text("\(details.previous.count)").monospacedDigit()
                                ThreadGlyph(name: "chevron-right", size: 16)
                            }
                        }
                    }
                    .buttonStyle(DetailsRowStyle())
                    .accessibilityIdentifier("thread.details.previousAgents")
                }
            }
        }
    }

    private var previousAgents: some View {
        ScrollView {
            if let details {
                DetailsSection {
                    ForEach(details.previous, id: \.key) { agent in agentRow(agent) }
                }
                .padding(EdgeInsets(top: 6, leading: 16, bottom: 40, trailing: 16))
            }
        }
        .scrollContentBackground(.hidden)
        .background(sheetBackground)
        .navigationTitle("Previous agents")
        .navigationBarTitleDisplayMode(.inline)
        .toolbar { closeButton }
        .accessibilityIdentifier("thread.details.previousAgentsPage")
    }

    // MARK: Sections

    private func pullRequests(_ prs: [FfiThreadPullRequest]) -> some View {
        let hidden = prs.count - Self.initialPullRequests
        let shown = showsAllPullRequests ? prs : Array(prs.prefix(Self.initialPullRequests))
        return DetailsSection(title: "Pull requests") {
            ForEach(shown, id: \.url) { pr in
                DetailsButton(id: "thread.details.pr.\(pr.number)", action: { onOpenPullRequest(pr) }) {
                    DetailsRow(
                        icon: ThreadGlyph(name: Self.pullRequestIcon(pr.state), size: 20)
                            .foregroundStyle(pullRequestColor(pr.state)),
                        label: pr.title,
                        meta: pr.meta
                    )
                }
            }
            if hidden > 0 {
                DetailsButton(id: "thread.details.prs.toggle", action: { showsAllPullRequests.toggle() }) {
                    DetailsRow(
                        icon: glyph(showsAllPullRequests ? "chevron-up" : "chevron-down"),
                        label: showsAllPullRequests ? "Show less" : "Show \(hidden) more",
                        muted: true
                    )
                }
            }
        }
    }

    @ViewBuilder
    private func git(_ details: FfiThreadDetails) -> some View {
        let branch = vcs?.isRepo == false ? nil : details.branch ?? vcs?.refName
        if vcs?.isRepo == false, let folder = details.folder {
            DetailsSection(title: "Git") {
                DetailsButton(id: "thread.details.initGit", action: { initGit(folder) }) {
                    DetailsRow(
                        icon: glyph("branch-add"),
                        label: initializing ? "Initializing…" : "Initialize Git",
                        meta: initError ?? "\(details.projectTitle ?? "This folder") is not a Git repository yet"
                    )
                }
                .disabled(initializing)
            }
        } else if let branch {
            DetailsSection(title: "Git") {
                DetailsButton(id: "thread.details.branch", action: { copy("branch", branch) }) {
                    DetailsRow(icon: glyph("branch"), label: branch) {
                        copiedMark("branch") { ThreadGlyph(name: "copy", size: 18) }
                    }
                }
                if let vcs, vcs.isRepo {
                    // iPhone has no working-tree diff view yet, so the row only reports the count.
                    DetailsRow(icon: glyph("file-diff"), label: "Changes") {
                        HStack(spacing: 4) {
                            Text("+\(vcs.insertions)").foregroundStyle(AdaptiveColor.emerald700300.color(colorScheme))
                            Text("−\(vcs.deletions)").foregroundStyle(AdaptiveColor.rose600400.color(colorScheme))
                        }
                        .monospacedDigit()
                    }
                    .accessibilityIdentifier("thread.details.changes")
                }
            }
        }
    }

    @ViewBuilder
    private func agentRow(_ agent: FfiThreadDetailsAgent) -> some View {
        let row = DetailsRow(
            icon: ProviderIcon(driver: agent.provider, size: 20)
                .frame(width: 20, height: 20)
                .projectStatusDot(Self.tone(agent.state), ring: ringColor),
            label: agent.title.isEmpty ? "Untitled agent" : agent.title,
            meta: agent.meta.isEmpty ? nil : agent.meta,
            muted: !agent.live
        )
        if agent.threadId != nil {
            DetailsButton(id: "thread.details.agent.\(agent.key)", action: { onOpenAgent(agent) }) { row }
        } else {
            row.accessibilityIdentifier("thread.details.agent.\(agent.key)")
        }
    }

    // MARK: Pieces

    @Environment(\.colorScheme) private var colorScheme

    private func glyph(_ name: String) -> some View {
        ThreadGlyph(name: name, size: 20).foregroundStyle(theme.mutedForeground)
    }

    /// The agents sheet's glass at the medium detent; opaque at the large one, as iOS 26 sheets are.
    private var sheetBackground: some View {
        theme.background.opacity(detent == .large ? 1 : 0.7).ignoresSafeArea()
    }

    /// Lab `--m-details-ring`: the screen colour with 12% of the text colour, the group's fill.
    private var ringColor: Color { theme.background.mix(with: theme.foreground, by: 0.12) }

    @ToolbarContentBuilder
    private var closeButton: some ToolbarContent {
        ToolbarItem(placement: .topBarTrailing) {
            Button(role: .close) { dismiss() }
                .accessibilityLabel("Close thread details")
                .accessibilityIdentifier("thread.details.close")
        }
    }

    private func copiedMark(_ id: String) -> some View {
        copiedMark(id) { EmptyView() }
    }

    @ViewBuilder
    private func copiedMark(_ id: String, @ViewBuilder idle: () -> some View) -> some View {
        if copied == id {
            HStack(spacing: 4) {
                ThreadGlyph(name: "check", size: 16)
                Text("Copied")
            }
            .foregroundStyle(AdaptiveColor.emerald700300.color(colorScheme))
        } else {
            idle()
        }
    }

    private func copy(_ id: String, _ value: String) {
        UIPasteboard.general.string = value
        UISelectionFeedbackGenerator().selectionChanged()
        copied = id
        Task {
            try? await Task.sleep(for: .seconds(1.5))
            if copied == id { copied = nil }
        }
    }

    /// What "Copy thread link" writes (desktop's `thread_link_for`).
    private var copyLink: String? {
        store.environmentId.map { threadLink(environmentId: $0, threadId: threadId) }
    }

    private func pullRequestColor(_ state: FfiThreadPullRequestState?) -> Color {
        switch state {
        case .open: AdaptiveColor.emerald700300.color(colorScheme)
        case .merged: AdaptiveColor.violet600400.color(colorScheme)
        case .closed: AdaptiveColor.rose600400.color(colorScheme)
        case .draft, nil: theme.mutedForeground
        }
    }

    private static func pullRequestIcon(_ state: FfiThreadPullRequestState?) -> String {
        switch state {
        case .merged: "merge"
        case .draft: "pull-request-draft"
        default: "pull-request"
        }
    }

    private static func tone(_ state: FfiThreadAgentState) -> StatusDotTone {
        switch state {
        case .running, .waiting: .working
        case .done: .done
        case .failed: .failed
        case .stopped, .idle: .waiting
        }
    }

    // MARK: Data

    private var hasRunningAgents: Bool { details?.running.isEmpty == false }

    /// What the rows read from: the shell (projects, children, PRs) and the open thread's feed.
    private var refreshKey: Int {
        feedSignature(store.shell?.threads.count, store.openThread?.entries.count,
                      store.openThread?.turnAgents, store.openThread?.branch)
    }

    private func refresh() async {
        if let next = await store.threadDetails(threadId: threadId), next != details { details = next }
    }

    private func loadVcs() async {
        guard let folder = details?.folder else { return }
        vcs = try? await store.vcsStatus(cwd: folder)
    }

    private func initGit(_ folder: String) {
        initializing = true
        initError = nil
        Task {
            defer { initializing = false }
            do {
                try await store.initGit(cwd: folder)
                await loadVcs()
            } catch {
                initError = error.localizedDescription
            }
        }
    }
}

/// Lab `.m-details-section`: an optional 14 pt heading over a rounded group whose rows are
/// divided by hairlines inset to the text.
private struct DetailsSection<Content: View>: View {
    var title: String?
    @ViewBuilder let content: Content
    @Environment(\.connTheme) private var theme

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            if let title {
                Text(title)
                    .font(.system(size: 14, weight: .medium))
                    .foregroundStyle(theme.mutedForeground)
                    .padding(.horizontal, 16)
                    .padding(.bottom, 7)
                    .accessibilityAddTraits(.isHeader)
            }
            VStack(spacing: 0) {
                Group(subviews: content) { rows in
                    ForEach(rows.indices, id: \.self) { index in
                        rows[index].overlay(alignment: .top) {
                            if index > 0 {
                                Rectangle().fill(theme.foreground.opacity(0.12)).frame(height: 1)
                                    .padding(.leading, 52)
                            }
                        }
                    }
                }
            }
            .background(theme.foreground.opacity(0.06))
            .clipShape(RoundedRectangle(cornerRadius: 20, style: .continuous))
        }
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier(title.map { "thread.details.section.\($0)" } ?? "thread.details.section")
    }
}

/// Lab `.m-details-row`: 48 pt, a 20 pt icon in a 24 pt column, 16 pt text, 13 pt meta, and
/// 15 pt muted trailing text.
private struct DetailsRow<Icon: View, Trailing: View>: View {
    let icon: Icon
    let label: String
    var meta: String?
    var muted = false
    @ViewBuilder var trailing: Trailing
    @Environment(\.connTheme) private var theme
    @State private var maxTrailing: CGFloat?

    init(icon: Icon, label: String, meta: String? = nil, muted: Bool = false,
         @ViewBuilder trailing: () -> Trailing) {
        self.icon = icon
        self.label = label
        self.meta = meta
        self.muted = muted
        self.trailing = trailing()
    }

    var body: some View {
        HStack(spacing: 12) {
            icon.frame(width: 24)
            VStack(alignment: .leading, spacing: 2) {
                Text(label)
                    .font(.system(size: 16))
                    .lineHeight(.exact(points: 21))
                    .foregroundStyle(muted ? theme.mutedForeground : theme.foreground)
                if let meta {
                    Text(meta)
                        .font(.system(size: 13))
                        .lineHeight(.exact(points: 17))
                        .foregroundStyle(theme.mutedForeground)
                }
            }
            .lineLimit(1)
            .truncationMode(.tail)
            .frame(maxWidth: .infinity, alignment: .leading)
            // Lab `.m-details-trailing`: at most 45% of the row, the label taking the rest.
            trailing
                .font(.system(size: 15))
                .foregroundStyle(theme.mutedForeground)
                .lineLimit(1)
                .frame(maxWidth: maxTrailing, alignment: .trailing)
                .fixedSize(horizontal: maxTrailing == nil, vertical: false)
                .layoutPriority(1)
        }
        .padding(.horizontal, 16)
        .padding(.vertical, 10)
        .frame(maxWidth: .infinity, minHeight: 48, alignment: .leading)
        .contentShape(Rectangle())
        .accessibilityElement(children: .combine)
        .onGeometryChange(for: CGFloat.self) { $0.size.width } action: { maxTrailing = $0 * 0.45 }
    }
}

extension DetailsRow where Trailing == EmptyView {
    init(icon: Icon, label: String, meta: String? = nil, muted: Bool = false) {
        self.init(icon: icon, label: label, meta: meta, muted: muted) { EmptyView() }
    }
}

/// A tappable row with the lab's pressed highlight.
private struct DetailsButton<Label: View>: View {
    let id: String
    let action: () -> Void
    @ViewBuilder let label: Label

    var body: some View {
        Button(action: action) { label }
            .buttonStyle(DetailsRowStyle())
            .accessibilityIdentifier(id)
    }
}

/// Lab `button.m-details-row:active`: the text colour at 6% while pressed.
private struct DetailsRowStyle: ButtonStyle {
    @Environment(\.connTheme) private var theme
    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .background(configuration.isPressed ? theme.foreground.opacity(0.06) : .clear)
    }
}
