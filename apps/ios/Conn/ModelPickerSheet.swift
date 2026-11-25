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
                    PhoneSettingsGroup {
                        switch page {
                        case .providers:
                            ForEach(picker?.sections ?? [], id: \.instanceId) { section in
                                Button { browse(section) } label: {
                                    HStack { ProviderIcon(driver: section.driver); Text(section.label); Spacer(); ConnIcon("chevron.right") }
                                        .frame(maxWidth: .infinity, minHeight: 44).contentShape(Rectangle())
                                }.accessibilityIdentifier("modelPicker.provider." + section.instanceId)
                            }
                        case .models(let instance):
                            if let section = picker?.sections.first(where: { $0.instanceId == instance }) {
                                let matches = section.models.filter { query.isEmpty || $0.label.localizedCaseInsensitiveContains(query) }
                                if matches.isEmpty { Text("No models match your search.").foregroundStyle(theme.mutedForeground) }
                                ForEach(matches, id: \.model) { row in
                                    Button {
                                        if !row.selected { optionChanges = [:] }
                                        pending = (row.instanceId, row.model)
                                        pages = []
                                    } label: {
                                        HStack {
                                            ProviderIcon(driver: section.driver)
                                            Text(displayName(row.label, provider: section.label))
                                            Spacer()
                                            if row.selected { ConnIcon("checkmark") }
                                        }.frame(maxWidth: .infinity, minHeight: 44).contentShape(Rectangle())
                                    }.accessibilityIdentifier("modelPicker.model." + row.model)
                                }
                            }
                        }
                    }.padding(.horizontal, 14)
                }.buttonStyle(.plain).background(theme.background)
                    .safeAreaInset(edge: .bottom) {
                        if case .models = page {
                            HStack(spacing: 8) {
                                Image(systemName: "magnifyingglass").foregroundStyle(theme.mutedForeground)
                                TextField("Find a model", text: $query)
                                    .textInputAutocapitalization(.never).autocorrectionDisabled()
                                    .accessibilityIdentifier("modelPicker.search")
                            }.padding(.horizontal, 14).frame(height: 44)
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
                    Button { dismiss() } label: { Image(systemName: "xmark") }
                        .accessibilityLabel("Cancel thread settings")
                }
                ToolbarItem(placement: .topBarTrailing) {
                    Button(picker?.hasPending == true || !optionChanges.isEmpty || steer != store.followUpSteers(threadId) ? "Save" : "Done") { commitAndClose() }
                        .fontWeight(.semibold).foregroundStyle(.blue)
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
