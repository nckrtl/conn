import DesignKit
import SwiftUI

/// Settings › Microphone, ported from Conn mobile's Voice screen: pick where dictation is
/// transcribed and, for an Operator server, sign in through the server's own login page.
struct SettingsMicrophoneView: View {
    @Environment(\.connTheme) private var theme
    @State private var model = VoiceSettingsModel.shared
    @State private var server = ""
    @State private var serverEdited = false

    private var settings: VoiceSettings { model.settings }
    private var draftServer: String { serverEdited ? server : settings.server }

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 24) {
                section("Transcription") {
                    choice("On this device", "Apple speech recognition, offline", selected: settings.engine == .device) {
                        model.selectEngine(.device)
                    }
                    choice(
                        "Operator server", "Higher quality; sends recordings to your server",
                        selected: settings.engine == .operator
                    ) { model.selectEngine(.operator) }
                }
                if settings.engine == .device && !OnDeviceTranscriber.isAvailable {
                    Text(OnDeviceTranscriber.unavailable.message)
                        .font(.system(size: 13)).foregroundStyle(theme.mutedForeground).padding(.horizontal, 16)
                }
                if settings.engine == .operator { operatorSection }
                if let error = model.error {
                    Text(error).font(.system(size: 13)).foregroundStyle(theme.destructive).padding(.horizontal, 16)
                }
            }
            .padding(.horizontal, 18).padding(.top, 14).padding(.bottom, 32)
        }
        .scrollDismissesKeyboard(.interactively)
        .background(theme.background.ignoresSafeArea())
        .navigationTitle("Microphone")
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            ToolbarItem(placement: .principal) { Text("Microphone").font(.system(size: 17, weight: .semibold)) }
        }
    }

    @ViewBuilder private var operatorSection: some View {
        section("Operator server") {
            if settings.signedIn {
                HStack(spacing: 12) {
                    VStack(alignment: .leading, spacing: 2) {
                        Text("Signed in").font(.system(size: 16, weight: .medium)).foregroundStyle(theme.foreground)
                        Text(signedInDetail).font(.system(size: 14)).foregroundStyle(theme.mutedForeground).lineLimit(2)
                    }
                    Spacer(minLength: 0)
                    Button("Sign out") { Task { await model.signOut() } }
                        .font(.system(size: 16)).foregroundStyle(theme.foreground)
                }
                .padding(.vertical, 8)
            } else {
                TextField("https://operator.test", text: Binding(get: { draftServer }, set: { server = $0; serverEdited = true; model.error = nil }))
                    .font(.system(size: 16))
                    .textInputAutocapitalization(.never)
                    .autocorrectionDisabled()
                    .keyboardType(.URL)
                    .submitLabel(.go)
                    .disabled(model.signingIn)
                    .onSubmit(signIn)
                    .accessibilityLabel("Operator server address")
                    .frame(minHeight: 48)
                Button(action: signIn) {
                    HStack(spacing: 8) {
                        Text("Sign in").font(.system(size: 16, weight: .medium))
                        if model.signingIn { ProgressView() }
                    }
                    .foregroundStyle(draftServer.trimmingCharacters(in: .whitespaces).isEmpty ? theme.mutedForeground : theme.foreground)
                    .frame(maxWidth: .infinity, minHeight: 48, alignment: .leading)
                    .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                .disabled(model.signingIn || draftServer.trimmingCharacters(in: .whitespaces).isEmpty)
            }
        }
    }

    private var signedInDetail: String {
        let host = settings.server.replacingOccurrences(of: #"^https?://"#, with: "", options: .regularExpression)
        return [settings.account, host].filter { !$0.isEmpty }.joined(separator: " · ")
    }

    private func signIn() {
        let entered = draftServer
        Task {
            await model.signIn(server: entered)
            if model.settings.signedIn { serverEdited = false }
        }
    }

    private func section<Content: View>(_ title: String, @ViewBuilder content: () -> Content) -> some View {
        VStack(alignment: .leading, spacing: 7) {
            Text(title).font(.system(size: 14, weight: .medium)).foregroundStyle(theme.mutedForeground).padding(.horizontal, 16)
            PhoneSettingsGroup(radius: 20, inset: 16) { content() }
        }
    }

    private func choice(_ title: String, _ detail: String, selected: Bool, action: @escaping () -> Void) -> some View {
        Button(action: action) {
            HStack(spacing: 12) {
                VStack(alignment: .leading, spacing: 2) {
                    Text(title).font(.system(size: 16)).foregroundStyle(theme.foreground)
                    Text(detail).font(.system(size: 14)).foregroundStyle(theme.mutedForeground)
                }
                Spacer(minLength: 0)
                if selected { ThreadGlyph(name: "check", size: 18).foregroundStyle(theme.foreground) }
            }
            .padding(.vertical, 8)
            .frame(maxWidth: .infinity, minHeight: 48, alignment: .leading)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .accessibilityAddTraits(selected ? .isSelected : [])
    }
}
