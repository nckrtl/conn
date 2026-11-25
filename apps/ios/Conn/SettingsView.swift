import DesignKit
import SwiftUI

/// Lab `CurrentSettingsSheet` presented as an iPhone pageSheet.
struct SettingsRootSheet: View {
    @Bindable var store: CoreStore
    @Environment(\.dismiss) private var dismiss
    @Environment(\.connTheme) private var theme

    var body: some View {
        NavigationStack {
            ScrollView {
                // Lab `.ios-settings-sheet`: 18 pt sides, a 14 pt title, 20 pt groups with 16 pt row insets.
                VStack(alignment: .leading, spacing: 7) {
                    Text("Connections").font(.system(size: 14, weight: .medium))
                        .foregroundStyle(theme.mutedForeground).padding(.horizontal, 16)
                    PhoneSettingsGroup(radius: 20, inset: 16) {
                        NavigationLink {
                            SettingsEnvironmentsDetailView(store: store)
                        } label: {
                            HStack(spacing: 10) {
                                ThreadGlyph(name: "desktop", size: 22).frame(width: 32, alignment: .leading)
                                Text("Environments").foregroundStyle(theme.foreground)
                                Spacer()
                                Text(String(store.linked.count + (store.isPaired ? 1 : 0))).foregroundStyle(theme.mutedForeground)
                                ThreadGlyph(name: "chevron-right", size: 15).foregroundStyle(theme.mutedForeground)
                            }
                            .font(.system(size: 16)).frame(minHeight: 48).contentShape(Rectangle())
                        }
                        .font(.system(size: 16)).foregroundStyle(theme.foreground)
                        .contentShape(Rectangle())
                    }
                }.padding(.horizontal, 18).padding(.top, 14)
            }.buttonStyle(.plain).background(theme.background)
            .settingsSheetTitle("Settings")
            .toolbar {
                ToolbarItem(placement: .topBarLeading) {
                    SheetGlassButton(glyph: "close", label: "Close settings") { dismiss() }
                        .accessibilityIdentifier("settings.closeButton")
                }
                .sharedBackgroundVisibility(.hidden)
            }
        }.tint(theme.foreground).presentationBackground(theme.background)
    }
}

/// Lab `.ios-settings-sheet` section: a 14pt medium muted title 16 in and 7 above a 20pt-radius group.
private struct SettingsSection<Content: View>: View {
    let title: String
    @ViewBuilder let content: Content
    @Environment(\.connTheme) private var theme

    init(_ title: String, @ViewBuilder content: () -> Content) {
        self.title = title
        self.content = content()
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 7) {
            Text(title).font(.system(size: 14, weight: .medium))
                .foregroundStyle(theme.mutedForeground).padding(.horizontal, 16)
            PhoneSettingsGroup(radius: 20, inset: 16) { content }
        }
    }
}

/// Lab `.ios-group p`: a 16pt label with a 14pt muted value at the trailing edge.
private struct SettingsValueRow: View {
    let title: String
    let value: String
    @Environment(\.connTheme) private var theme

    var body: some View {
        HStack(spacing: 12) {
            Text(title).font(.system(size: 16)).foregroundStyle(theme.foreground)
            Spacer(minLength: 0)
            Text(value).font(.system(size: 14)).foregroundStyle(theme.mutedForeground)
                .multilineTextAlignment(.trailing)
        }
    }
}

/// Lab `.ios-group button`: a 16pt regular, left-aligned action in the foreground colour.
private struct SettingsActionRow: View {
    let title: String
    let action: () -> Void
    @Environment(\.connTheme) private var theme

    var body: some View {
        Button(action: action) {
            Text(title).font(.system(size: 16)).foregroundStyle(theme.foreground)
                .frame(maxWidth: .infinity, minHeight: 48, alignment: .leading).contentShape(Rectangle())
        }.buttonStyle(.plain)
    }
}

private struct SettingsNoteRow: View {
    let text: String
    @Environment(\.connTheme) private var theme

    var body: some View {
        Text(text).font(.system(size: 13)).foregroundStyle(theme.mutedForeground).padding(.vertical, 12)
    }
}

/// The lab's status words, not a status pill.
@MainActor private func connectionStatusText(_ store: CoreStore) -> String {
    if store.showsOffline { return "Not connected" }
    switch store.status {
    case .connected: return "Connected"
    case .connecting, .none: return "Connecting"
    case .reconnecting: return "Reconnecting"
    case .failed: return "Not connected"
    }
}

private struct SettingsEnvironmentsDetailView: View {
    @Bindable var store: CoreStore
    @Environment(\.connTheme) private var theme

    @State private var adding = false
    @State private var pairingURL = ""

    var body: some View {
        ScrollView {
            VStack(spacing: 28) {
                SettingsSection("Connected environment") {
                    if let serverURL = store.serverURL {
                        SettingsValueRow(title: "Server", value: URL(string: serverURL)?.host ?? serverURL)
                    }
                    SettingsValueRow(title: "Status", value: store.isPaired ? connectionStatusText(store) : "Disconnected")
                    if let error = store.olderError { SettingsNoteRow(text: error) }
                    if let error = store.lastError { SettingsNoteRow(text: error) }
                    if store.isPaired {
                        SettingsActionRow(title: "Reconnect") { store.reconnect() }
                        SettingsActionRow(title: "Disconnect") { store.disconnect() }
                    }
                }
                SettingsSection("Linked environments") {
                    if let error = store.discoveryError {
                        SettingsNoteRow(text: error)
                        SettingsActionRow(title: "Retry discovery") { Task { await store.discoverLinked() } }
                    }
                    ForEach(store.linked.keys.sorted(), id: \.self) { id in
                        if let child = store.linked[id] {
                            SettingsValueRow(title: child.displayName, value: connectionStatusText(child))
                            if let error = child.olderError { SettingsNoteRow(text: error) }
                            if child.showsOffline || child.lastError != nil {
                                if case let .failed(message, detail, _) = child.state?.phase {
                                    SettingsNoteRow(text: [message, detail].compactMap { $0 }.joined(separator: " "))
                                } else if let message = child.lastError { SettingsNoteRow(text: message) }
                                SettingsActionRow(title: "Retry " + child.displayName) { child.reconnect() }
                            }
                            SettingsActionRow(title: "Disconnect") { store.removeLinked(id) }
                                .accessibilityLabel("Disconnect " + child.displayName)
                        }
                    }
                    ForEach(store.disabledOrbitLinks, id: \.self) { id in
                        SettingsActionRow(title: "Reconnect " + id) { store.enableOrbitLink(id) }
                    }
                    SettingsActionRow(title: "Link environment") { pairingURL = ""; adding = true }
                }
            }
            .padding(.horizontal, 18).padding(.top, 14).padding(.bottom, 32)
        }
        .background(theme.background.ignoresSafeArea())
        .alert("Link environment", isPresented: $adding) {
            TextField("Pairing URL", text: $pairingURL).textInputAutocapitalization(.never)
            Button("Cancel", role: .cancel) {}
            Button("Connect") { store.addLinked(pairingURL) }
        }
        .settingsSheetTitle("Environments")
    }
}

private extension View {
    /// Lab `.ios-sheet header`: a 17pt semibold title (the app's bar titles are 18 medium).
    func settingsSheetTitle(_ title: String) -> some View {
        navigationTitle(title)
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .principal) {
                    Text(title).font(.system(size: 17, weight: .semibold))
                }
            }
    }
}

struct PhoneSettingsGroup<Content: View>: View {
    @Environment(\.connTheme) private var theme
    var radius: CGFloat = 16
    var inset: CGFloat = 14
    @ViewBuilder let content: Content

    var body: some View {
        VStack(spacing: 0) {
            Group(subviews: content) { rows in
                ForEach(rows.indices, id: \.self) { index in
                    if index > 0 { PhoneSettingsDivider().padding(.horizontal, inset) }
                    rows[index].frame(maxWidth: .infinity, minHeight: 48, alignment: .leading)
                        .padding(.horizontal, inset)
                }
            }
        }.background(theme.settingsGroup, in: RoundedRectangle(cornerRadius: radius, style: .continuous))
    }
}

/// Lab `.ios-thread-options > * + *::before`: a 1 pt line in the text colour at 16%.
struct PhoneSettingsDivider: View {
    @Environment(\.connTheme) private var theme
    var body: some View { Rectangle().fill(theme.foreground.opacity(0.16)).frame(height: 1) }
}

/// Lab `.ios-thread-options label::after`: a 6 pt box with a 1.5 pt right and bottom border,
/// turned 45 degrees, which draws a small down chevron.
private struct DropdownChevron: View {
    @Environment(\.connTheme) private var theme
    var body: some View {
        Path { path in
            path.move(to: CGPoint(x: 0, y: 0))
            path.addLine(to: CGPoint(x: 4.243, y: 4.243))
            path.addLine(to: CGPoint(x: 8.485, y: 0))
        }
        .stroke(theme.mutedForeground, style: StrokeStyle(lineWidth: 1.5, lineCap: .square, lineJoin: .miter))
        .frame(width: 8.5, height: 4.3)
        .accessibilityHidden(true)
    }
}

struct PhoneOptionRow: View {
    let title: String
    var value = ""
    var provider: String?
    var disclosure = "chevron.right"
    @Environment(\.connTheme) private var theme
    var body: some View {
        HStack(spacing: 8) {
            Text(title).foregroundStyle(theme.foreground)
            Spacer()
            if let provider { ProviderIcon(driver: provider, size: 16) }
            if !value.isEmpty { Text(value).foregroundStyle(theme.mutedForeground).lineLimit(1) }
            if disclosure == "chevron.right" {
                ThreadGlyph(name: "chevron-right", size: 14).foregroundStyle(theme.mutedForeground)
            } else if disclosure == "chevron.down" {
                DropdownChevron()
            } else if !disclosure.isEmpty {
                Image(systemName: disclosure).font(.system(size: 12)).foregroundStyle(theme.mutedForeground)
            }
        }.font(.system(size: 16)).frame(minHeight: 48).contentShape(Rectangle())
    }
}
