import Foundation
import os

// Operator dictation over a WebSocket, ported from Operator's iPhone app (ios/App/OperatorServer.swift,
// `DictationStream`). Recording starts at the tap. The socket opens in the background and the
// captured 16 kHz mono int16 samples go out in 100 ms messages. At the stop the server sends the
// tail and the whole text at once. Any failure ends in an upload of the recording kept on disk.

// MARK: Timing log

/// One dictation's timing lines, in milliseconds since the tap.
/// Read them with: log show --info --predicate 'subsystem == "com.nckrtl.conn.ios" AND category == "dictation"'
final class DictationTimeline: @unchecked Sendable {
    static let log = Logger(subsystem: "com.nckrtl.conn.ios", category: "dictation")

    let id: String
    private let start: TimeInterval
    private let lock = NSLock()
    private var once: Set<String> = []

    init(now: TimeInterval = ProcessInfo.processInfo.systemUptime) {
        start = now
        id = String(UUID().uuidString.prefix(4)).lowercased()
    }

    static func line(id: String, ms: Int, event: String, detail: String = "") -> String {
        "[\(id)] +\(ms)ms \(event)" + (detail.isEmpty ? "" : " \(detail)")
    }

    func milliseconds(now: TimeInterval = ProcessInfo.processInfo.systemUptime) -> Int {
        max(0, Int(((now - start) * 1000).rounded()))
    }

    func mark(_ event: String, _ detail: String = "") {
        let text = Self.line(id: id, ms: milliseconds(), event: event, detail: detail)
        Self.log.info("\(text, privacy: .public)")
    }

    /// Marks the first call only (the first frame, the first audio).
    func markOnce(_ event: String, _ detail: String = "") {
        let first = lock.withLock { once.insert(event).inserted }
        if first { mark(event, detail) }
    }
}

// MARK: Framing

/// Splits captured samples into 100 ms messages (3200 bytes of 16 kHz int16). Messages made before
/// the socket is open wait in `held` and go out in order when it opens.
struct StreamFraming: Equatable {
    static let messageBytes = 3200

    private(set) var remainder = Data()
    private(set) var held: [Data] = []
    private(set) var connected = false
    /// Samples handed to the socket.
    private(set) var samplesSent = 0

    /// Adds samples. Returns the full messages that can go out now (none while not connected).
    mutating func append(_ samples: [Int16]) -> [Data] {
        samples.withUnsafeBytes { remainder.append(contentsOf: $0) }
        var ready: [Data] = []
        while remainder.count >= Self.messageBytes {
            ready.append(Data(remainder.prefix(Self.messageBytes)))
            remainder = Data(remainder.dropFirst(Self.messageBytes))
        }
        return route(ready)
    }

    /// The socket is open: the held messages, oldest first.
    mutating func connect() -> [Data] {
        connected = true
        let out = held
        held = []
        samplesSent += out.reduce(0) { $0 + $1.count / 2 }
        return out
    }

    /// The last, shorter message (what is left under 100 ms). Call once, after the last `append`.
    mutating func finish() -> [Data] {
        guard !remainder.isEmpty else { return [] }
        let last = remainder
        remainder = Data()
        return route([last])
    }

    private mutating func route(_ messages: [Data]) -> [Data] {
        guard connected else {
            held.append(contentsOf: messages)
            return []
        }
        samplesSent += messages.reduce(0) { $0 + $1.count / 2 }
        return messages
    }
}

// MARK: Protocol

struct StreamTail: Equatable, Sendable {
    var text: String
    var language: String?
    var partials: Int
    /// The phrases and the tail as one text, for a stream started with `live: false`.
    var whole: String?
}

/// What the server sends on `/v1/stream`; other types are ignored.
enum StreamReply: Equatable, Sendable {
    case ready
    case partial(text: String, language: String?, seq: Int, samples: Int)
    case tail(StreamTail)
    case result(text: String, language: String?, tail: String?, partials: Int?)
    case error(String)
}

enum StreamProtocol {
    static let rate: Double = 16_000
    /// How long a silence lasts before the server sends the phrase so far (Operator's default).
    static let defaultPause = 0.25

    /// How long the stop waits for the text before the recording is uploaded instead: 4 s plus 1%
    /// of the recording.
    static func answerTimeout(samples: Int) -> TimeInterval { 4 + Double(samples) / rate * 0.01 }

    /// The `/v1/stream` WebSocket on the speech address, with the upload's bearer token.
    static func request(speech: String, token: String) -> URLRequest? {
        guard let base = URL(string: speech), var components = URLComponents(url: base, resolvingAgainstBaseURL: false),
              base.host != nil else { return nil }
        components.scheme = components.scheme == "https" ? "wss" : "ws"
        let prefix = components.path.hasSuffix("/") ? String(components.path.dropLast()) : components.path
        components.path = prefix + "/v1/stream"
        guard let url = components.url else { return nil }
        var request = URLRequest(url: url)
        request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
        return request
    }

    /// Sent before the samples. `live: false` leaves nothing typed until the stop and puts the whole
    /// text on the tail.
    static func startMessage(pause: Double, language: String? = nil, live: Bool = false) -> String {
        var fields: [String: Any] = ["type": "start", "pause": pause]
        if let language { fields["language"] = language }
        if !live { fields["live"] = false }
        return json(fields)
    }

    /// Sent after the last samples: how many were sent.
    static func stopMessage(samples: Int, language: String? = nil) -> String {
        var fields: [String: Any] = ["type": "stop", "samples": samples]
        if let language { fields["language"] = language }
        return json(fields)
    }

    private static func json(_ fields: [String: Any]) -> String {
        let data = (try? JSONSerialization.data(withJSONObject: fields, options: [.sortedKeys])) ?? Data("{}".utf8)
        return String(decoding: data, as: UTF8.self)
    }

    static func reply(from raw: Data) -> StreamReply? {
        guard let fields = (try? JSONSerialization.jsonObject(with: raw)) as? [String: Any],
              let type = fields["type"] as? String else { return nil }
        func int(_ key: String) -> Int? { (fields[key] as? NSNumber)?.intValue }
        switch type {
        case "ready":
            return .ready
        case "partial":
            return .partial(text: fields["text"] as? String ?? "", language: fields["language"] as? String,
                            seq: int("seq") ?? 0, samples: int("samples") ?? 0)
        case "tail":
            return .tail(StreamTail(text: fields["tail"] as? String ?? "", language: fields["language"] as? String,
                                    partials: int("partials") ?? 0, whole: fields["text"] as? String))
        case "result":
            return .result(text: fields["text"] as? String ?? "", language: fields["language"] as? String,
                           tail: fields["tail"] as? String, partials: int("partials"))
        case "error":
            return .error(fields["message"] as? String ?? "The stream failed.")
        default:
            return nil
        }
    }

    /// The text to insert when the tail arrives, or `nil` to wait for the final text. The server's
    /// `whole` is the phrases and the tail as one text; an older server has none, so the phrases
    /// and the tail are joined here.
    static func earlyText(tail: StreamTail, phrases: [String]) -> String? {
        let whole = tail.whole?.trimmingCharacters(in: .whitespacesAndNewlines)
        let text = whole ?? join(phrases + [tail.text])
        return text.isEmpty ? nil : text
    }

    static func join(_ pieces: [String]) -> String {
        pieces.map { $0.trimmingCharacters(in: .whitespacesAndNewlines) }.filter { !$0.isEmpty }.joined(separator: " ")
    }
}

/// What the stop does once the stream has answered or failed.
enum DictationFallback {
    enum Action: Equatable {
        /// The early text is already in the draft; an upload would insert it twice.
        case skip
        /// Insert the stream's final text.
        case insertStreamText
        /// Upload the recording kept on disk.
        case upload
    }

    static func afterStream(earlyInserted: Bool, streamSucceeded: Bool) -> Action {
        if earlyInserted { return .skip }
        return streamSucceeded ? .insertStreamText : .upload
    }
}

// MARK: Stream

/// One dictation streamed to the Operator server while it is recorded. A failure (no connection, a
/// lost message, no answer in time, a server error) throws from `finish`; the caller uploads the
/// recording it kept.
final class DictationStream: @unchecked Sendable {
    private static let session: URLSession = {
        let configuration = URLSessionConfiguration.ephemeral
        configuration.timeoutIntervalForRequest = 10
        configuration.waitsForConnectivity = false
        return URLSession(configuration: configuration)
    }()

    private let task: URLSessionWebSocketTask
    private let timeline: DictationTimeline
    private let pause: Double
    private let onEarlyText: @Sendable (String) -> Void
    private let queue = DispatchQueue(label: "com.nckrtl.conn.dictation.stream")
    // Touched only on `queue`.
    private var framing = StreamFraming()
    private var failure: Error?
    private var stopSamples: Int?
    private var stopGate: Gate?
    private var phrases: [(seq: Int, text: String)] = []
    private var receiveTask: Task<Void, Never>?
    private let outcome = Outcome()

    /// `onEarlyText` runs once at most, when the tail has the text to insert (any thread).
    init(request: URLRequest, timeline: DictationTimeline, pause: Double = StreamProtocol.defaultPause,
         onEarlyText: @escaping @Sendable (String) -> Void) {
        self.timeline = timeline
        self.pause = pause
        self.onEarlyText = onEarlyText
        task = Self.session.webSocketTask(with: request)
        task.delegate = Opened { [weak self] in
            self?.queue.async { self?.opened() }
        }
        task.resume()
        receiveTask = Task { [weak self] in await self?.receive() }
    }

    deinit {
        receiveTask?.cancel()
        task.cancel(with: .goingAway, reason: nil)
    }

    /// A captured chunk (the audio thread). Before the socket is open it is framed and held.
    func append(_ samples: [Int16]) {
        queue.async { [self] in
            guard failure == nil else { return }
            for message in framing.append(samples) { sendAudio(message) }
        }
    }

    /// Sends the rest and the stop (`samples`: how many the recording has), then waits for the final
    /// text. The stop gives up after 3 s, the wait after `answerTimeout`.
    func finish(samples: Int) async throws -> String {
        try await sendStop(samples: samples)
        timeline.mark("stop-sent")
        return try await withThrowingTaskGroup(of: String.self) { group in
            group.addTask { try await self.outcome.wait() }
            group.addTask {
                try await Task.sleep(for: .seconds(StreamProtocol.answerTimeout(samples: samples)))
                throw VoiceError("The server did not answer the stream in time.")
            }
            defer { group.cancelAll(); task.cancel(with: .goingAway, reason: nil) }
            return try await group.next()!
        }
    }

    /// The dictation was cancelled.
    func cancel() {
        receiveTask?.cancel()
        task.cancel(with: .goingAway, reason: nil)
    }

    // MARK: Sending (on `queue`)

    private func opened() {
        timeline.mark("socket-connected")
        send(.string(StreamProtocol.startMessage(pause: pause)))
        for message in framing.connect() { sendAudio(message) }
        trySendStop()
    }

    private func sendAudio(_ message: Data) {
        timeline.markOnce("first-frame", "bytes=\(message.count)")
        send(.data(message))
    }

    private func send(_ message: URLSessionWebSocketTask.Message) {
        task.send(message) { [self] error in
            if let error { queue.async { self.fail(error) } }
        }
    }

    private func fail(_ error: Error) {
        failure = failure ?? error
        stopGate?.fail(error)
    }

    private func requestStop(samples: Int, gate: Gate) {
        stopSamples = samples
        stopGate = gate
        if let failure { gate.fail(failure); return }
        trySendStop()
    }

    /// Once the socket is open and the stop is wanted: the last audio, then the stop.
    private func trySendStop() {
        guard let samples = stopSamples, let gate = stopGate, framing.connected else { return }
        stopSamples = nil
        for message in framing.finish() { sendAudio(message) }
        guard framing.samplesSent == samples else {
            gate.fail(VoiceError("The stream has \(framing.samplesSent) of \(samples) samples."))
            return
        }
        task.send(.string(StreamProtocol.stopMessage(samples: samples))) { error in
            if let error { gate.fail(error) } else { gate.succeed() }
        }
    }

    /// The stop message, or an error. A late send callback cannot resume the wait twice.
    private func sendStop(samples: Int) async throws {
        let gate = Gate()
        try await withThrowingTaskGroup(of: Void.self) { group in
            group.addTask { [self] in
                try await withCheckedThrowingContinuation { (continuation: CheckedContinuation<Void, Error>) in
                    gate.arm(continuation)
                    queue.async { self.requestStop(samples: samples, gate: gate) }
                }
            }
            group.addTask { [self] in
                try await Task.sleep(for: .seconds(3))
                let error = VoiceError("The stream did not take the stop.")
                gate.fail(error)
                task.cancel(with: .goingAway, reason: nil)
                throw error
            }
            defer { group.cancelAll() }
            try await group.next()!
        }
    }

    // MARK: Receiving

    private func receive() async {
        while !Task.isCancelled {
            do {
                let message = try await task.receive()
                let raw: Data
                switch message {
                case .string(let text): raw = Data(text.utf8)
                case .data(let data): raw = data  // a text frame can arrive as data
                @unknown default: continue
                }
                guard let reply = StreamProtocol.reply(from: raw) else { continue }
                switch reply {
                case .ready:
                    timeline.mark("ready")
                case let .partial(text, _, seq, _):
                    queue.async { [self] in
                        if !phrases.contains(where: { $0.seq == seq }) { phrases.append((seq, text)) }
                    }
                case let .tail(tail):
                    timeline.mark("tail", "partials=\(tail.partials) whole=\(tail.whole != nil)")
                    queue.async { [self] in
                        let ordered = phrases.sorted { $0.seq < $1.seq }.map(\.text)
                        if let text = StreamProtocol.earlyText(tail: tail, phrases: ordered) { onEarlyText(text) }
                    }
                case let .result(text, _, _, _):
                    timeline.mark("final", "chars=\(text.count)")
                    outcome.set(.success(text.trimmingCharacters(in: .whitespacesAndNewlines)))
                    return
                case let .error(message):
                    let error = VoiceError(message)
                    outcome.set(.failure(error))
                    queue.async { [self] in fail(error) }
                    return
                }
            } catch {
                outcome.set(.failure(error))
                queue.async { [self] in fail(error) }
                return
            }
        }
    }

    /// The socket's handshake finished.
    private final class Opened: NSObject, URLSessionWebSocketDelegate, @unchecked Sendable {
        private let handler: @Sendable () -> Void
        init(_ handler: @escaping @Sendable () -> Void) { self.handler = handler }
        func urlSession(_ session: URLSession, webSocketTask: URLSessionWebSocketTask, didOpenWithProtocol protocol: String?) {
            handler()
        }
    }

    /// Resumes one continuation, whether the stop is accepted or the wait gives up first.
    private final class Gate: @unchecked Sendable {
        private let lock = NSLock()
        private var continuation: CheckedContinuation<Void, Error>?
        private var result: Result<Void, Error>?

        func arm(_ continuation: CheckedContinuation<Void, Error>) {
            lock.lock()
            if let result {
                lock.unlock()
                continuation.resume(with: result)
                return
            }
            self.continuation = continuation
            lock.unlock()
        }

        func succeed() { finish(.success(())) }

        func fail(_ error: Error) { finish(.failure(error)) }

        private func finish(_ result: Result<Void, Error>) {
            lock.lock()
            if self.result != nil { lock.unlock(); return }
            self.result = result
            let continuation = self.continuation
            self.continuation = nil
            lock.unlock()
            continuation?.resume(with: result)
        }
    }

    /// The final text, delivered once, whether it arrives before or after `finish` starts waiting.
    private final class Outcome: @unchecked Sendable {
        private let lock = NSLock()
        private var value: Result<String, Error>?
        private var waiter: CheckedContinuation<String, Error>?

        func set(_ result: Result<String, Error>) {
            lock.lock()
            if value == nil { value = result }
            let waiter = self.waiter
            let stored = value!
            self.waiter = nil
            lock.unlock()
            waiter?.resume(with: stored)
        }

        func wait() async throws -> String {
            try await withTaskCancellationHandler {
                try await withCheckedThrowingContinuation { (continuation: CheckedContinuation<String, Error>) in
                    lock.lock()
                    if let value {
                        lock.unlock()
                        continuation.resume(with: value)
                    } else {
                        waiter = continuation
                        lock.unlock()
                    }
                }
            } onCancel: {
                let waiter = self.takeWaiter()
                waiter?.resume(throwing: CancellationError())
            }
        }

        private func takeWaiter() -> CheckedContinuation<String, Error>? {
            lock.lock()
            defer { lock.unlock() }
            let waiter = self.waiter
            self.waiter = nil
            return waiter
        }
    }
}
