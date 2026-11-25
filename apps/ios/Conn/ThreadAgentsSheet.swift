import SwiftUI

/// Mobile's `ThreadAgentsSheet`: this turn's subagents, each drawn like a thread list row (the
/// provider icon with its status dot, the title, and model · status · age below).
struct ThreadAgentsSheet: View {
    let agents: [ThreadView.TurnSubagent]
    let onOpen: (ThreadView.TurnSubagent) -> Void
    @Environment(\.connTheme) private var theme
    @Environment(\.dismiss) private var dismiss

    var body: some View {
        NavigationStack {
            List(agents) { agent in
                Button { onOpen(agent) } label: { ThreadAgentRow(agent: agent) }
                    .buttonStyle(.plain)
                    .disabled(agent.child == nil)
                    .listRowInsets(EdgeInsets(top: 2, leading: 0, bottom: 2, trailing: 0))
                    .listRowSeparator(.hidden)
                    .listRowBackground(Color.clear)
                    .accessibilityIdentifier("thread.agents.\(agent.id)")
            }
            .listStyle(.plain)
            .scrollContentBackground(.hidden)
            // Keeps the system Liquid Glass but tints it with the screen colour, so the sheet reads
            // as dark as the glass buttons over the feed instead of as bright as the thread behind it.
            .background(theme.background.opacity(ConnGlass.tint).ignoresSafeArea())
            .overlay {
                if agents.isEmpty {
                    Text("No agents in this turn.")
                        .font(.system(size: 15))
                        .foregroundStyle(theme.mutedForeground)
                }
            }
            .navigationTitle("Agents")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .topBarTrailing) {
                    Button(role: .close) { dismiss() }
                }
            }
        }
        .presentationDetents([.medium, .large])
        .presentationDragIndicator(.visible)
    }
}

/// `ThreadListV2RowView`'s layout and type, for one subagent.
private struct ThreadAgentRow: View {
    let agent: ThreadView.TurnSubagent
    @Environment(\.connTheme) private var theme

    private let iconSize: CGFloat = 20
    private let titleGap: CGFloat = 12

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            HStack(alignment: .center, spacing: titleGap) {
                ProviderIcon(driver: agent.provider, size: iconSize)
                    .frame(width: iconSize, height: iconSize)
                    .projectStatusDot(tone)
                Text(agent.title.isEmpty ? "Untitled agent" : agent.title)
                    .font(.system(size: 16, weight: agent.settled ? .regular : .medium))
                    .foregroundStyle(agent.settled ? theme.mutedForeground : theme.foreground)
                    .lineLimit(1)
                    .truncationMode(.tail)
                    .frame(maxWidth: .infinity, minHeight: 20, alignment: .leading)
            }
            Text(metaLine)
                .font(.system(size: 13))
                .foregroundStyle(theme.mutedForeground)
                .lineLimit(1)
                .truncationMode(.tail)
                .frame(maxWidth: .infinity, minHeight: 17, alignment: .leading)
                .padding(.leading, iconSize + titleGap)
        }
        .padding(EdgeInsets(top: 12, leading: 4, bottom: 12, trailing: 8))
        .padding(.horizontal, 8)
        .contentShape(Rectangle())
    }

    private var tone: StatusDotTone {
        switch agent.state {
        case .running, .pending: .working
        case .waiting: .waiting
        case .failed, .interrupted: .failed
        case .cancelled, .idle: .waiting
        case .completed: .done
        }
    }

    private var metaLine: String {
        var parts: [String] = []
        if let model = agent.model, !model.isEmpty { parts.append(model) }
        if !agent.status.isEmpty { parts.append(agent.status) }
        if let date = parseISODate(from: agent.updatedAt) { parts.append(wholeMinuteRelativeTime(from: date)) }
        return parts.joined(separator: " · ")
    }
}
