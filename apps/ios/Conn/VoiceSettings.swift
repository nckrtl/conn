import Foundation

/// Dictation settings, ported from Conn mobile's `operatorTranscription.ts`. Pure value types and
/// request builders live here so they can be tested without a network or a device.

enum VoiceEngine: String, Codable, Sendable, Equatable {
    case device
    case `operator`
}

struct VoiceSettings: Codable, Sendable, Equatable {
    var engine: VoiceEngine = .device
    /// The server's web address as entered, such as `https://operator.test`.
    var server = ""
    /// Where dictation goes, from the sign-in answer. Empty until signed in.
    var speech = ""
    var token = ""
    /// "user · team · device" from the sign-in answer.
    var account = ""

    var signedIn: Bool { !token.isEmpty && !speech.isEmpty }

    init() {}

    /// Tolerant like the Expo store: unknown or missing fields fall back to the defaults.
    init(from decoder: Decoder) throws {
        let values = try decoder.container(keyedBy: CodingKeys.self)
        engine = (try? values.decode(VoiceEngine.self, forKey: .engine)) ?? .device
        server = (try? values.decode(String.self, forKey: .server)) ?? ""
        speech = (try? values.decode(String.self, forKey: .speech)) ?? ""
        token = (try? values.decode(String.self, forKey: .token)) ?? ""
        account = (try? values.decode(String.self, forKey: .account)) ?? ""
    }
}

/// Keychain accounts. The token lives in the settings JSON, so it is Keychain-only.
enum VoiceStorageKey {
    static let settings = "voice-transcription-v2"
    static let deviceKey = "voice-transcription-device-key"
}

enum VoiceSettingsStore {
    static func load() -> VoiceSettings {
        guard let raw = KeychainStore.loadSecret(account: VoiceStorageKey.settings),
              let settings = try? JSONDecoder().decode(VoiceSettings.self, from: Data(raw.utf8)) else {
            return VoiceSettings()
        }
        return settings
    }

    @discardableResult
    static func save(_ settings: VoiceSettings) -> Bool {
        guard let data = try? JSONEncoder().encode(settings) else { return false }
        return KeychainStore.saveSecret(String(decoding: data, as: UTF8.self), account: VoiceStorageKey.settings)
    }

    /// A stable random key that names this install to the server's device list.
    static func deviceKey() -> String {
        if let saved = KeychainStore.loadSecret(account: VoiceStorageKey.deviceKey), saved.count >= 16 {
            return saved
        }
        let made = (0..<16).map { _ in String(format: "%02x", UInt8.random(in: 0...255)) }.joined()
        KeychainStore.saveSecret(made, account: VoiceStorageKey.deviceKey)
        return made
    }
}

/// Which engine records go to. An Operator choice never falls back to the device.
enum VoiceRoute: Equatable {
    case device
    case `operator`(speech: String, token: String)
    case needsSignIn
}

struct VoiceError: LocalizedError, Equatable {
    let message: String
    var errorDescription: String? { message }
    init(_ message: String) { self.message = message }
}

enum OperatorVoice {
    static let openAIPort = 12331
    static let signInHint = "Sign in to your Operator server in Settings › Microphone."
    static let signedOutMessage = "Your Operator sign-in has ended. Sign in again in Settings › Microphone."

    static func route(for settings: VoiceSettings) -> VoiceRoute {
        switch settings.engine {
        case .device: return .device
        case .operator:
            return settings.signedIn ? .operator(speech: settings.speech, token: settings.token) : .needsSignIn
        }
    }

    /// `operator.test` means https; a host with a port, such as `10.44.0.7:12332`, means http.
    static func serverURL(_ entered: String) throws -> URL {
        let trimmed = entered.trimmingCharacters(in: .whitespacesAndNewlines)
            .trimmingCharacters(in: CharacterSet(charactersIn: "/"))
        let full = trimmed.contains("://") ? trimmed : "\(trimmed.contains(":") ? "http" : "https")://\(trimmed)"
        guard let url = URL(string: full), let scheme = url.scheme?.lowercased(),
              scheme == "http" || scheme == "https", let host = url.host, !host.isEmpty else {
            throw VoiceError("Enter the server address, such as https://operator.test.")
        }
        return url
    }

    /// `scheme://host[:port]` of a URL, the part sign-in requests are sent to.
    static func origin(_ url: URL) -> String {
        var text = "\(url.scheme ?? "https")://\(url.host ?? "")"
        if let port = url.port { text += ":\(port)" }
        return text
    }

    /// The dictation base from the server's `openai` URL, or this host on the OpenAI port.
    static func speechBase(server: URL, openai: Any?) -> String {
        var given = (openai as? String) ?? ""
        while given.hasSuffix("/") { given.removeLast() }
        return given.isEmpty ? "http://\(server.host ?? ""):\(openAIPort)" : given
    }

    static func jsonRequest(_ url: URL, body: [String: Any]?, token: String? = nil) throws -> URLRequest {
        var request = URLRequest(url: url, timeoutInterval: 10)
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "Accept")
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        if let token, !token.isEmpty { request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization") }
        if let body { request.httpBody = try JSONSerialization.data(withJSONObject: body) }
        return request
    }

    static func authorizeRequest(server: URL, deviceName: String, deviceKey: String) throws -> URLRequest {
        try jsonRequest(
            URL(string: origin(server) + "/api/devices/authorize")!,
            body: ["name": deviceName, "platform": "ios", "device_key": deviceKey]
        )
    }

    static func tokenRequest(server: URL, deviceCode: String) throws -> URLRequest {
        try jsonRequest(URL(string: origin(server) + "/api/devices/token")!, body: ["device_code": deviceCode])
    }

    static func signOutRequest(server: String, token: String) throws -> URLRequest? {
        guard !server.isEmpty, !token.isEmpty, let url = URL(string: server + "/api/devices/sign-out") else { return nil }
        return try jsonRequest(url, body: nil, token: token)
    }

    /// A multipart upload of the recording: an M4A as the Expo flow sends it, or the WAV that the
    /// stream keeps for its fallback (`audio/wav`, as Operator's iPhone app uploads it).
    static func transcriptionRequest(speech: String, token: String, audio: Data, filename: String, contentType: String = "audio/m4a", boundary: String = UUID().uuidString) throws -> URLRequest {
        guard let url = URL(string: speech + "/v1/audio/transcriptions") else {
            throw VoiceError("The Operator dictation address is not valid. Sign in again in Settings › Microphone.")
        }
        var request = URLRequest(url: url, timeoutInterval: 120)
        request.httpMethod = "POST"
        request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
        request.setValue("multipart/form-data; boundary=\(boundary)", forHTTPHeaderField: "Content-Type")
        var body = Data()
        func append(_ text: String) { body.append(Data(text.utf8)) }
        append("--\(boundary)\r\nContent-Disposition: form-data; name=\"response_format\"\r\n\r\njson\r\n")
        append("--\(boundary)\r\nContent-Disposition: form-data; name=\"file\"; filename=\"\(filename)\"\r\nContent-Type: \(contentType)\r\n\r\n")
        body.append(audio)
        append("\r\n--\(boundary)--\r\n")
        request.httpBody = body
        return request
    }

    static func account(from json: [String: Any]) -> String {
        let device = (json["device"] as? [String: Any])?["name"] as? String
        return [json["user"] as? String, json["team"] as? String, device]
            .compactMap { $0 }
            .filter { !$0.isEmpty }
            .joined(separator: " · ")
    }

    static func transcriptionText(from data: Data) -> String {
        let json = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any]
        return ((json?["text"] as? String) ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
    }

    static func failureMessage(status: Int, data: Data) -> String {
        if status == 401 || status == 403 { return signedOutMessage }
        let json = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any]
        if let message = (json?["error"] as? [String: Any])?["message"] as? String { return "Operator: \(message)" }
        return "The Operator server answered \(status)."
    }
}

/// Where dictated text goes in the draft. Offsets count characters.
enum DictationInsertion {
    static func insert(_ dictated: String, into text: String, at range: Range<Int>?) -> (text: String, cursor: Int) {
        let trimmed = dictated.trimmingCharacters(in: .whitespacesAndNewlines)
        let characters = Array(text)
        guard !trimmed.isEmpty else { return (text, min(range?.upperBound ?? characters.count, characters.count)) }
        let lower = min(max(range?.lowerBound ?? characters.count, 0), characters.count)
        let upper = min(max(range?.upperBound ?? characters.count, lower), characters.count)
        let before = String(characters[..<lower])
        let after = String(characters[upper...])
        let needsLead = before.last.map { !$0.isWhitespace } ?? false
        let needsTail = after.first.map { !$0.isWhitespace } ?? false
        let lead = needsLead ? " " : ""
        let tail = needsTail ? " " : ""
        let inserted = lead + trimmed + tail
        return (before + inserted + after, before.count + lead.count + trimmed.count)
    }
}
