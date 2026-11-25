import AVFoundation
import AuthenticationServices
import Foundation
import Speech
import SwiftUI
import UIKit

// Dictation, ported from Conn mobile: record an M4A, then transcribe it on this device (Apple
// SpeechAnalyzer, iOS 26) or on an Operator server. An Operator failure is shown, never retried
// on the device.

// MARK: Settings and Operator sign-in

/// The saved dictation choice and the Operator sign-in, shared by Settings and the composer.
@MainActor @Observable
final class VoiceSettingsModel {
    static let shared = VoiceSettingsModel()

    private(set) var settings: VoiceSettings
    private(set) var signingIn = false
    var error: String?

    private let sheet = OperatorSignInSheet()

    init(settings: VoiceSettings = VoiceSettingsStore.load()) { self.settings = settings }

    func selectEngine(_ engine: VoiceEngine) {
        settings.engine = engine
        error = VoiceSettingsStore.save(settings) ? nil : "Could not save the transcription choice."
    }

    /// Opens the server's sign-in page and waits until it approves this device, as Operator's own
    /// iPhone app does. Closing the sheet cancels. The token and dictation address are saved.
    func signIn(server entered: String) async {
        guard !signingIn else { return }
        signingIn = true
        error = nil
        defer { signingIn = false }
        do {
            try await runSignIn(entered)
        } catch is CancellationError {
        } catch {
            self.error = error.localizedDescription
        }
    }

    func signOut() async {
        let (server, token) = (settings.server, settings.token)
        settings.token = ""
        settings.account = ""
        settings.speech = ""
        error = VoiceSettingsStore.save(settings) ? nil : "Could not save the sign-out."
        if let request = try? OperatorVoice.signOutRequest(server: server, token: token) {
            _ = try? await URLSession.shared.data(for: request)
        }
    }

    private func runSignIn(_ entered: String) async throws {
        let server = try OperatorVoice.serverURL(entered)
        let name = UIDevice.current.name.trimmingCharacters(in: .whitespacesAndNewlines)
        let started = try await Self.send(
            OperatorVoice.authorizeRequest(
                server: server, deviceName: name.isEmpty ? "Conn" : name, deviceKey: VoiceSettingsStore.deviceKey()
            ),
            host: server.host ?? ""
        )
        let deviceCode = started.json["device_code"] as? String ?? ""
        let page = (started.json["verification_uri_complete"] as? String).flatMap(URL.init(string:))
        guard !deviceCode.isEmpty, let page, page.host == server.host, page.port == server.port else {
            throw VoiceError(
                started.status >= 400
                    ? "The Operator server answered \(started.status)." : "Unexpected answer from the Operator server."
            )
        }
        let interval = max(1, (started.json["interval"] as? Double) ?? 2)
        let expiresAt = Date().addingTimeInterval((started.json["expires_in"] as? Double) ?? 600)

        // The sheet only shows the server's pages; approval is learned by polling, as Operator does.
        let closed = SheetClosed()
        sheet.open(page) { closed.value = true }
        defer { sheet.dismiss() }
        while Date() < expiresAt {
            try await Task.sleep(for: .seconds(interval))
            if closed.value { return }
            let answer = try await Self.send(
                OperatorVoice.tokenRequest(server: server, deviceCode: deviceCode), host: server.host ?? ""
            )
            if let token = answer.json["token"] as? String, !token.isEmpty {
                var next = settings
                next.engine = .operator
                next.server = OperatorVoice.origin(server)
                next.speech = OperatorVoice.speechBase(server: server, openai: answer.json["openai"])
                next.token = token
                next.account = OperatorVoice.account(from: answer.json)
                guard VoiceSettingsStore.save(next) else { throw VoiceError("Could not save the sign-in.") }
                settings = next
                return
            }
            let code = answer.json["error"] as? String ?? ""
            if code == "authorization_pending" || code == "slow_down" { continue }
            throw VoiceError(code == "access_denied" ? "The sign-in was denied." : "The code expired. Sign in again.")
        }
        throw VoiceError("The code expired. Sign in again.")
    }

    private static func send(_ request: URLRequest, host: String) async throws -> (status: Int, json: [String: Any]) {
        do {
            let (data, response) = try await URLSession.shared.data(for: request)
            let json = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any] ?? [:]
            return ((response as? HTTPURLResponse)?.statusCode ?? 0, json)
        } catch is CancellationError {
            throw CancellationError()
        } catch {
            throw VoiceError("The Operator server does not answer at \(host).")
        }
    }
}

@MainActor private final class SheetClosed { var value = false }

/// The browser sheet for the server's login page. It has no callback address: it stays open until
/// the person closes it or sign-in finishes and the app dismisses it.
@MainActor
private final class OperatorSignInSheet: NSObject, ASWebAuthenticationPresentationContextProviding {
    private var session: ASWebAuthenticationSession?

    func open(_ url: URL, onClosed: @escaping @MainActor () -> Void) {
        session?.cancel()
        let session = ASWebAuthenticationSession(url: url, callbackURLScheme: nil) { _, _ in
            Task { @MainActor in onClosed() }
        }
        session.presentationContextProvider = self
        self.session = session
        session.start()
    }

    func dismiss() {
        session?.cancel()
        session = nil
    }

    func presentationAnchor(for session: ASWebAuthenticationSession) -> ASPresentationAnchor {
        let scenes = UIApplication.shared.connectedScenes.compactMap { $0 as? UIWindowScene }
        return scenes.flatMap(\.windows).first(where: \.isKeyWindow) ?? ASPresentationAnchor()
    }
}

// MARK: Recording

@MainActor
final class VoiceRecorder {
    private var recorder: AVAudioRecorder?

    func start() async throws {
        guard await AVAudioApplication.requestRecordPermission() else {
            throw VoiceError("Allow microphone access for Conn in Settings to dictate.")
        }
        let session = AVAudioSession.sharedInstance()
        try session.setCategory(.record, mode: .default, options: [.allowBluetoothHFP])
        try session.setActive(true)
        let url = FileManager.default.temporaryDirectory.appending(path: "conn-dictation-\(UUID().uuidString).m4a")
        let recorder = try AVAudioRecorder(
            url: url,
            settings: [
                AVFormatIDKey: Int(kAudioFormatMPEG4AAC),
                AVSampleRateKey: 44_100,
                AVNumberOfChannelsKey: 1,
                AVEncoderAudioQualityKey: AVAudioQuality.high.rawValue,
            ]
        )
        guard recorder.record() else { throw VoiceError("Conn could not start recording.") }
        self.recorder = recorder
    }

    /// Stops and returns the recording, or `nil` when none was running.
    func stop() -> URL? {
        guard let recorder else { return nil }
        recorder.stop()
        self.recorder = nil
        try? AVAudioSession.sharedInstance().setActive(false, options: .notifyOthersOnDeactivation)
        return recorder.url
    }

    func discard() {
        if let url = stop() { try? FileManager.default.removeItem(at: url) }
    }
}

// MARK: Transcription

enum VoiceTranscription {
    static func transcribe(_ file: URL, route: VoiceRoute) async throws -> String {
        switch route {
        case .device: return try await OnDeviceTranscriber.transcribe(file)
        case let .operator(speech, token): return try await operatorTranscribe(file, speech: speech, token: token)
        case .needsSignIn: throw VoiceError(OperatorVoice.signInHint)
        }
    }

    private static func operatorTranscribe(_ file: URL, speech: String, token: String) async throws -> String {
        let host = URL(string: speech)?.host ?? speech
        let request = try OperatorVoice.transcriptionRequest(
            speech: speech, token: token, audio: try Data(contentsOf: file), filename: "dictation.m4a"
        )
        let data: Data
        let response: URLResponse
        do {
            (data, response) = try await URLSession.shared.data(for: request)
        } catch is CancellationError {
            throw CancellationError()
        } catch {
            throw VoiceError("Cannot reach the Operator server at \(host).")
        }
        let status = (response as? HTTPURLResponse)?.statusCode ?? 0
        guard (200..<300).contains(status) else {
            throw VoiceError(OperatorVoice.failureMessage(status: status, data: data))
        }
        return OperatorVoice.transcriptionText(from: data)
    }
}

/// Apple's SpeechAnalyzer (iOS 26) on the recorded file. It tries the person's languages in order.
enum OnDeviceTranscriber {
    static let unavailable = VoiceError(
        "Dictation on this device needs iOS 26 or later, a supported device, and a supported language."
    )

    static var isAvailable: Bool { SpeechTranscriber.isAvailable }

    static func transcribe(_ file: URL) async throws -> String {
        guard isAvailable else { throw unavailable }
        guard await speechAllowed() else {
            throw VoiceError("Allow speech recognition for Conn in Settings to dictate on this device.")
        }
        let preferred = Locale.preferredLanguages.map(Locale.init(identifier:)) + [Locale.current]
        var locale: Locale?
        for candidate in preferred {
            if let supported = await SpeechTranscriber.supportedLocale(equivalentTo: candidate) {
                locale = supported
                break
            }
        }
        guard let locale else { throw VoiceError("Voice transcription does not support any of your languages.") }

        let transcriber = SpeechTranscriber(locale: locale, preset: .transcription)
        do {
            if let download = try await AssetInventory.assetInstallationRequest(supporting: [transcriber]) {
                try await download.downloadAndInstall()
            }
            let analyzer = SpeechAnalyzer(modules: [transcriber])
            let collected = Task { () throws -> String in
                var text = ""
                for try await result in transcriber.results { text += String(result.text.characters) }
                return text
            }
            let audio = try AVAudioFile(forReading: file)
            if let last = try await analyzer.analyzeSequence(from: audio) {
                try await analyzer.finalizeAndFinish(through: last)
            } else {
                await analyzer.cancelAndFinishNow()
            }
            return try await collected.value.trimmingCharacters(in: .whitespacesAndNewlines)
        } catch let error as VoiceError {
            throw error
        } catch is CancellationError {
            throw CancellationError()
        } catch {
            throw VoiceError("Voice transcription failed.")
        }
    }

    private static func speechAllowed() async -> Bool {
        switch SFSpeechRecognizer.authorizationStatus() {
        case .authorized: return true
        case .notDetermined:
            return await withCheckedContinuation { continuation in
                SFSpeechRecognizer.requestAuthorization { continuation.resume(returning: $0 == .authorized) }
            }
        default: return false
        }
    }
}

// MARK: Controller

/// One composer's dictation: tap to record, stop to transcribe and hand the text back.
@MainActor @Observable
final class DictationController {
    enum Phase: Equatable {
        case idle
        case starting
        case recording(since: Date)
        case transcribing
    }

    private(set) var phase = Phase.idle
    var error: String?

    var isActive: Bool { phase != .idle }

    private let recorder = VoiceRecorder()
    private var work: Task<Void, Never>?

    func start() {
        guard phase == .idle else { return }
        error = nil
        guard OperatorVoice.route(for: VoiceSettingsModel.shared.settings) != .needsSignIn else {
            error = OperatorVoice.signInHint
            return
        }
        phase = .starting
        work = Task {
            do {
                try await recorder.start()
                guard phase == .starting else { return recorder.discard() }
                phase = .recording(since: Date())
            } catch {
                guard phase == .starting else { return }
                phase = .idle
                self.error = error.localizedDescription
            }
        }
    }

    func cancel() {
        work?.cancel()
        work = nil
        recorder.discard()
        phase = .idle
    }

    /// Stops recording and transcribes it. `insert` runs on success with the text.
    func finish(insert: @escaping @MainActor (String) -> Void) {
        guard case .recording = phase, let file = recorder.stop() else { return }
        phase = .transcribing
        let route = OperatorVoice.route(for: VoiceSettingsModel.shared.settings)
        work = Task {
            defer { try? FileManager.default.removeItem(at: file) }
            do {
                let text = try await VoiceTranscription.transcribe(file, route: route)
                guard phase == .transcribing else { return }
                phase = .idle
                if text.isEmpty { error = "No speech was heard." } else { insert(text) }
            } catch is CancellationError {
            } catch {
                guard phase == .transcribing else { return }
                phase = .idle
                self.error = error.localizedDescription
            }
        }
    }
}
