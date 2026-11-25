import SwiftUI
import UIKit

struct ModelPickerSheet: View {
    @Bindable var store: CoreStore
    let threadId: String

    @Environment(\.dismiss) private var dismiss
    @Environment(\.connTheme) private var theme
    private enum Page: Hashable { case providers, models(String) }
    @State private var pages: [Page] = []
    @State private var query = ""
    @State private var toggled: [String] = []
    @State private var pending: (instanceId: String, model: String)?
    @State private var picker: FfiModelPicker?
    @State private var optionChanges: [String: String] = [:]
    @State private var steer = false
    @State private var saving = false
    @State private var showingUnavailable = false

    private var reloadKey: String {
        let pick = pending.map { "\($0.instanceId):\($0.model)" } ?? ""
        let model = store.openThread?.modelLabel ?? ""
        return "\(store.providersRevision)|\(toggled.joined(separator: ","))|\(pick)|\(model)"
    }

    var body: some View {
        NavigationStack(path: $pages) {
            ScrollView {
                VStack(alignment: .leading, spacing: 24) {
                    if let picker, picker.loaded {
                        let section = picker.sections.first { $0.models.contains(where: \.selected) }
                        let row = section?.models.first(where: \.selected)
                        if picker.sections.isEmpty {
                            Text("No models available.").foregroundStyle(.secondary)
                        } else {
                            PhoneSettingsGroup {
                                Button { pages.append(.providers) } label: {
                                    PhoneOptionRow(title: "Provider", value: section?.label ?? "Select", provider: section?.driver)
                                }
                                if let section {
                                    Button { browse(section) } label: {
                                        PhoneOptionRow(title: "Model", value: row.map { displayName($0.label, provider: section.label) } ?? "Select")
                                    }
                                }
                                if let row {
                                    ForEach(row.controls, id: \.id) { control in
                                        let current = optionChanges[control.id] ?? control.current
                                        let label = control.toggle || control.id == "serviceTier" ? "Speed" : "Effort"
                                        Menu {
                                            ForEach(Array(zip(control.values, control.labels)), id: \.0) { value, name in
                                                Button {
                                                    pending = (row.instanceId, row.model)
                                                    optionChanges[control.id] = value == control.current ? nil : value
                                                } label: {
                                                    if current == value { Label(name, systemImage: "checkmark") } else { Text(name) }
                                                }
                                            }
                                        } label: {
                                            PhoneOptionRow(title: label,
                                                           value: control.values.firstIndex(of: current).map { control.labels[$0] } ?? current,
                                                           disclosure: "chevron.down")
                                        }
                                    }
                                }
                            }
                        }
                    } else { ProgressView("Loading models…") }
                    VStack(alignment: .leading, spacing: 8) {
                        PhoneSettingsGroup {
                            Menu {
                                Button("Steer") { steer = true }
                                Button("Queue") { steer = false }
                            } label: {
                                PhoneOptionRow(title: "Follow-up messages", value: steer ? "Steer" : "Queue", disclosure: "chevron.down")
                            }
                        }
                        Text(steer ? "Send follow-ups to the running turn." : "Send follow-ups after the running turn finishes.")
                            .font(.system(size: 13)).foregroundStyle(theme.mutedForeground).padding(.horizontal, 14)
                    }
                }.padding(.horizontal, 14)
            }
            .buttonStyle(.plain).background(theme.background)
            .navigationDestination(for: Page.self) { page in
                ScrollView {
                    switch page {
                    case .providers:
                        ModelListGroup {
                            ForEach(picker?.sections ?? [], id: \.instanceId) { section in
                                Button { browse(section) } label: {
                                    ModelListRow(driver: section.driver, title: section.label, trailing: "chevron-right", trailingSize: 14)
                                }.accessibilityIdentifier("modelPicker.provider." + section.instanceId)
                            }
                        }
                    case .models(let instance):
                        if let section = picker?.sections.first(where: { $0.instanceId == instance }) {
                            let matches = section.models.filter { query.isEmpty || $0.label.localizedCaseInsensitiveContains(query) }
                            if matches.isEmpty {
                                Text("No models match your search.").foregroundStyle(theme.mutedForeground).padding(.top, 10)
                            } else {
                                ModelListGroup {
                                    ForEach(matches, id: \.model) { row in
                                        Button {
                                            if !row.selected { optionChanges = [:] }
                                            pending = (row.instanceId, row.model)
                                            pages = []
                                        } label: {
                                            ModelListRow(driver: section.driver, title: displayName(row.label, provider: section.label),
                                                         trailing: row.selected ? "check" : nil, trailingSize: 16)
                                        }.accessibilityIdentifier("modelPicker.model." + row.model)
                                    }
                                }
                            }
                        }
                    }
                }
                .padding(.horizontal, 14)
                .buttonStyle(.plain).background(theme.background)
                .navigationBarBackButtonHidden()
                .toolbar {
                    ToolbarItem(placement: .topBarLeading) {
                        SheetGlassButton(glyph: "chevron-left", label: "Back") { pages.removeLast() }
                    }
                    .sharedBackgroundVisibility(.hidden)
                }
                    .safeAreaInset(edge: .bottom) {
                        if case .models = page {
                            HStack(spacing: 6) {
                                ThreadGlyph(name: "search", size: 16).foregroundStyle(theme.mutedForeground)
                                TextField("Find a model", text: $query)
                                    .textInputAutocapitalization(.never).autocorrectionDisabled()
                                    .accessibilityIdentifier("modelPicker.search")
                            }.padding(.horizontal, 12).frame(height: 44)
                                .glassEffect(.regular, in: .capsule).padding(.horizontal, 14)
                        }
                    }
                    .navigationTitle(pageTitle(page))
                    .navigationBarTitleDisplayMode(.inline)
            }
            .navigationTitle("Thread settings")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .topBarLeading) {
                    SheetGlassButton(glyph: "close", label: "Cancel thread settings") { dismiss() }
                }
                .sharedBackgroundVisibility(.hidden)
                ToolbarItem(placement: .topBarTrailing) {
                    Button(picker?.hasPending == true || !optionChanges.isEmpty || steer != store.followUpSteers(threadId) ? "Save" : "Done") { commitAndClose() }
                        .fontWeight(.semibold).foregroundStyle(theme.primary)
                        .disabled(saving)
                        .accessibilityIdentifier("modelPicker.confirm")
                }.sharedBackgroundVisibility(.hidden)
            }
        }
        .tint(theme.foreground)
        .presentationBackground(theme.background)
        .onAppear { steer = store.followUpSteers(threadId) }
        .alert("Model unavailable", isPresented: $showingUnavailable) {
            Button("OK", role: .cancel) {}
        } message: {
            Text("Set up this provider on web or desktop, or select another model.")
        }
        // `ProviderWorkspaceSnapshotScan`: models only the project's own config lists.
        // Asked again whenever the provider list changes, so a sheet opened before providers
        // arrived scans once they do; a pending scan asks again when the core says to.
        .task(id: store.providersRevision) {
            while !Task.isCancelled,
                  let delay = await store.scanThreadWorkspaceModels(threadId: threadId) {
                try? await Task.sleep(for: .milliseconds(max(delay, 250)))
            }
        }
        .task(id: reloadKey) {
            let result = await store.modelPicker(
                threadId: threadId,
                query: "",
                toggled: toggled,
                pending: pending
            )
            if !Task.isCancelled { picker = result }
        }
    }

    /// `commitPendingModel`: the core sends the pick only while the catalog still offers it;
    /// otherwise the sheet stays open with mobile's "Model unavailable" alert.
    private func commitAndClose() {
        guard let pending, picker?.hasPending == true || !optionChanges.isEmpty else {
            store.setFollowUpSteers(steer, threadId: threadId)
            dismiss()
            return
        }
        saving = true
        Task {
            let result = await store.saveThreadModel(
                threadId: threadId,
                instanceId: pending.instanceId,
                model: pending.model, changes: optionChanges
            )
            saving = false
            switch result {
            case .saved?, .unchanged?:
                store.setFollowUpSteers(steer, threadId: threadId)
                dismiss()
            case .unavailable?: showingUnavailable = true
            // The thread's scope is still loading; the sheet keeps its loading state.
            case .notReady?, nil: break
            }
        }
    }

    private func pageTitle(_ page: Page) -> String {
        switch page {
        case .providers: "Provider"
        case .models(let instance): picker?.sections.first { $0.instanceId == instance }?.label ?? "Models"
        }
    }

    private func displayName(_ model: String, provider: String) -> String {
        model.hasPrefix(provider + " ") ? String(model.dropFirst(provider.count + 1)) : model
    }

    private func browse(_ section: FfiModelPickerSection) {
        query = ""
        if section.collapsed {
            if toggled.contains(section.instanceId) { toggled.removeAll { $0 == section.instanceId } }
            else { toggled.append(section.instanceId) }
        }
        pages.append(.models(section.instanceId))
    }
}

/// Lab `GlassButton`: a 44 pt glass circle with a 22 pt glyph (the sheet's close and back).
struct SheetGlassButton: View {
    let glyph: String
    let label: String
    let action: () -> Void
    @Environment(\.connTheme) private var theme

    var body: some View {
        Button(action: action) {
            ThreadGlyph(name: glyph, size: 22)
                .foregroundStyle(theme.foreground)
                .frame(width: 44, height: 44)
                .glassEffect(.regular.interactive(), in: .circle)
        }
        .accessibilityLabel(label)
    }
}

/// Lab `.ios-model-list .ios-group`: a 16 pt group in the settings fill, rows apart by a 0.5 pt line.
private struct ModelListGroup<Content: View>: View {
    @Environment(\.connTheme) private var theme
    @ViewBuilder let content: Content

    var body: some View {
        VStack(spacing: 0) {
            Group(subviews: content) { rows in
                ForEach(rows.indices, id: \.self) { index in
                    if index > 0 { Rectangle().fill(theme.border).frame(height: 0.5) }
                    rows[index]
                }
            }
        }
        .background(theme.settingsGroup, in: RoundedRectangle(cornerRadius: 16, style: .continuous))
        .clipShape(RoundedRectangle(cornerRadius: 16, style: .continuous))
        .padding(.top, 10)
    }
}

/// A provider or model row: icon, title at 16/500 and an optional trailing glyph, 10 apart, 44 high.
private struct ModelListRow: View {
    let driver: String?
    let title: String
    let trailing: String?
    let trailingSize: CGFloat
    @Environment(\.connTheme) private var theme

    var body: some View {
        HStack(spacing: 10) {
            ProviderIcon(driver: driver)
            Text(title).font(.system(size: 16, weight: .medium)).foregroundStyle(theme.foreground)
                .frame(maxWidth: .infinity, alignment: .leading)
            if let trailing {
                ThreadGlyph(name: trailing, size: trailingSize)
                    .foregroundStyle(trailing == "check" ? theme.foreground : theme.mutedForeground)
            }
        }
        .padding(.horizontal, 14)
        .frame(maxWidth: .infinity, minHeight: 44)
        .contentShape(Rectangle())
    }
}
