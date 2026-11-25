import DesignKit
import SwiftUI

/// 1:1 port of `SettingsRouteScreen.tsx` presented as an iPhone pageSheet (`SETTINGS_OPENS_AS_SHEET`).
struct SettingsRootSheet: View {
    @Bindable var store: CoreStore
    @Environment(\.dismiss) private var dismiss
    @Environment(\.connTheme) private var theme

    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(alignment: .leading, spacing: 7) {
                    Text("Connections").font(.system(size: 14, weight: .medium))
                        .foregroundStyle(theme.mutedForeground).padding(.horizontal, 16)
                    PhoneSettingsGroup {
                        NavigationLink {
                            SettingsEnvironmentsDetailView(store: store)
                        } label: {
                            HStack(spacing: 12) {
                                ConnIcon("desktopcomputer").frame(width: 22)
                                PhoneOptionRow(title: "Environments", value: String(store.linked.count + (store.isPaired ? 1 : 0)))
                            }
                        }
                    }
                }.padding(.horizontal, 14).padding(.top, 14)
            }.buttonStyle(.plain).background(theme.background)
            .navigationTitle("Settings")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .topBarLeading) {
                    Button {
                        dismiss()
                    } label: {
                        Image(systemName: "xmark")
                    }
                    .accessibilityLabel("Close")
                    .accessibilityIdentifier("settings.closeButton")
                }
            }
        }.tint(theme.foreground).presentationBackground(theme.background)
    }
}

private struct SettingsEnvironmentsDetailView: View {
    @Bindable var store: CoreStore
    @Environment(\.connTheme) private var theme

    @State private var adding = false
    @State private var pairingURL = ""

    var body: some View {
        List {
            Section("Connected environment") {
                if let serverURL = store.serverURL {
                    LabeledContent("Server", value: serverURL)
                }
                LabeledContent("Status") {
                    ConnectionStatusPill(status: store.status)
                }
                if let error = store.olderError { Text(error).foregroundStyle(.secondary) }
                if let error = store.lastError { Text(error).foregroundStyle(.secondary) }
                Button {
                    store.reconnect()
                } label: {
                    Text("Reconnect")
                }
                Button(role: .destructive) {
                    store.disconnect()
                } label: {
                    Text("Disconnect")
                }
            }
            .listRowBackground(theme.settingsGroup)
            Section("Linked environments") {
                if let error = store.discoveryError {
                    Text(error).foregroundStyle(.secondary)
                    Button("Retry discovery") { Task { await store.discoverLinked() } }
                }
                ForEach(store.linked.keys.sorted(), id: \.self) { id in
                    if let child = store.linked[id] {
                        LabeledContent(child.displayName) { ConnectionStatusPill(status: child.status) }
                            .swipeActions {
                                Button("Disconnect", role: .destructive) { store.removeLinked(id) }
                            }
                        if let error = child.olderError { Text(error).font(.caption) }
                        if child.showsOffline || child.lastError != nil {
                            if case let .failed(message, detail, _) = child.state?.phase {
                                Text([message, detail].compactMap { $0 }.joined(separator: " ")).font(.caption)
                            } else if let message = child.lastError { Text(message).font(.caption) }
                            Button("Retry " + child.displayName) { child.reconnect() }
                        }
                    }
                }
                ForEach(store.disabledOrbitLinks, id: \.self) { id in
                    Button("Reconnect " + id) { store.enableOrbitLink(id) }
                }
                Button("Link environment") { pairingURL = ""; adding = true }
            }
            .listRowBackground(theme.settingsGroup)
        }
        .contentMargins(.horizontal, 14, for: .scrollContent)
        .listStyle(.insetGrouped)
        .contentMargins(.top, 6, for: .scrollContent)
        .listSectionSpacing(24)
        .scrollContentBackground(.hidden)
        .background(theme.background.ignoresSafeArea())
        .alert("Link environment", isPresented: $adding) {
            TextField("Pairing URL", text: $pairingURL).textInputAutocapitalization(.never)
            Button("Cancel", role: .cancel) {}
            Button("Connect") { store.addLinked(pairingURL) }
        }
        .navigationTitle("Environments")
        .navigationBarTitleDisplayMode(.inline)
    }
}

struct PhoneSettingsGroup<Content: View>: View {
    @Environment(\.connTheme) private var theme
    @ViewBuilder let content: Content

    var body: some View {
        VStack(spacing: 0) {
            Group(subviews: content) { rows in
                ForEach(rows.indices, id: \.self) { index in
                    if index > 0 { PhoneSettingsDivider().padding(.horizontal, 14) }
                    rows[index].frame(maxWidth: .infinity, minHeight: 48, alignment: .leading)
                        .padding(.horizontal, 14)
                }
            }
        }.background(theme.settingsGroup, in: RoundedRectangle(cornerRadius: 16))
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
