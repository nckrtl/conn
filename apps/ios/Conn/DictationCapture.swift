import AVFoundation
import Foundation

// The Operator engine's capture, ported from Operator's iPhone `Recorder`: an AVAudioEngine tap
// converted to 16 kHz mono int16. Every chunk goes to the stream and to a WAV file on disk, the
// fallback if the stream fails. The engine starts off the main thread, so the tap never waits for
// the audio session, the microphone or the network.

// MARK: WAV file

enum WavFile {
    static let headerBytes = 44

    /// A 16 kHz mono 16-bit PCM header for `sampleCount` samples.
    static func header(sampleCount: Int, rate: Int = Int(StreamProtocol.rate)) -> Data {
        var data = Data()
        func append<T: FixedWidthInteger>(_ value: T) {
            withUnsafeBytes(of: value.littleEndian) { data.append(contentsOf: $0) }
        }
        let bytes = UInt32(truncatingIfNeeded: sampleCount * 2)
        data.append(Data("RIFF".utf8)); append(36 &+ bytes)
        data.append(Data("WAVEfmt ".utf8)); append(UInt32(16)); append(UInt16(1)); append(UInt16(1))
        append(UInt32(rate)); append(UInt32(rate * 2)); append(UInt16(2)); append(UInt16(16))
        data.append(Data("data".utf8)); append(bytes)
        return data
    }
}

/// Appends samples to a WAV file as they arrive; the header is fixed when it closes.
final class PCMFileWriter: @unchecked Sendable {
    let url: URL
    private let queue = DispatchQueue(label: "com.nckrtl.conn.dictation.file")
    private var handle: FileHandle?
    private var samples = 0

    init() throws {
        url = FileManager.default.temporaryDirectory.appending(path: "conn-dictation-\(UUID().uuidString).wav")
        guard FileManager.default.createFile(atPath: url.path, contents: WavFile.header(sampleCount: 0)) else {
            throw VoiceError("Conn could not start recording.")
        }
        let handle = try FileHandle(forWritingTo: url)
        try handle.seekToEnd()
        self.handle = handle
    }

    func append(_ chunk: [Int16]) {
        queue.async { [self] in
            guard let handle else { return }
            let data = chunk.withUnsafeBytes { Data($0) }
            try? handle.write(contentsOf: data)
            samples += chunk.count
        }
    }

    /// Writes the header and closes the file. Waits for the queued writes.
    func close() -> URL {
        queue.sync {
            if let handle {
                try? handle.seek(toOffset: 0)
                try? handle.write(contentsOf: WavFile.header(sampleCount: samples))
                try? handle.close()
            }
            handle = nil
        }
        return url
    }

    func discard() {
        queue.sync {
            try? handle?.close()
            handle = nil
        }
        try? FileManager.default.removeItem(at: url)
    }
}

// MARK: Microphone

/// The tap's converter, boxed so the audio callback can hold it.
private final class ConverterBox: @unchecked Sendable {
    let converter: AVAudioConverter
    init(_ converter: AVAudioConverter) { self.converter = converter }
}

final class StreamRecorder: @unchecked Sendable {
    private let engine = AVAudioEngine()
    private let timeline: DictationTimeline
    private let sink: @Sendable ([Int16]) -> Void
    private let lock = NSLock()
    private var capturing = true
    private var wanted = true
    private var observers: [NSObjectProtocol] = []
    private let format = AVAudioFormat(commonFormat: .pcmFormatInt16, sampleRate: StreamProtocol.rate, channels: 1, interleaved: false)!
    /// Every engine and audio session change runs here, in order: activating the session and
    /// starting the engine takes a noticeable moment (more with Bluetooth).
    private let audioQueue = DispatchQueue(label: "com.nckrtl.conn.dictation.audio", qos: .userInteractive)

    /// `sink` gets each chunk in order on the audio thread.
    init(timeline: DictationTimeline, sink: @escaping @Sendable ([Int16]) -> Void) {
        self.timeline = timeline
        self.sink = sink
        // iOS stops the engine for a new input route (AirPods) or after a call or Siri.
        let center = NotificationCenter.default
        observers.append(center.addObserver(forName: .AVAudioEngineConfigurationChange, object: engine, queue: nil) { [weak self] _ in
            self?.recover()
        })
        observers.append(center.addObserver(forName: AVAudioSession.interruptionNotification, object: nil, queue: nil) { [weak self] note in
            let type = (note.userInfo?[AVAudioSessionInterruptionTypeKey] as? UInt).flatMap(AVAudioSession.InterruptionType.init)
            if type == .ended { self?.recover() }
        })
    }

    deinit {
        for observer in observers { NotificationCenter.default.removeObserver(observer) }
    }

    /// Opens the microphone off the main thread; `done` gets the error, or `nil` once it runs.
    func start(_ done: @escaping @Sendable (Error?) -> Void) {
        audioQueue.async { [self] in
            guard lock.withLock({ wanted }) else { return done(nil) }  // stopped before it opened
            do {
                try startEngine()
                timeline.mark("microphone-open")
                done(nil)
            } catch {
                done(error)
            }
        }
    }

    /// No more samples reach the sink after this returns; the engine stops in the background.
    func stop() {
        lock.withLock {
            capturing = false
            wanted = false
        }
        audioQueue.async { [self] in
            engine.inputNode.removeTap(onBus: 0)
            engine.stop()
            try? AVAudioSession.sharedInstance().setActive(false, options: .notifyOthersOnDeactivation)
        }
    }

    private func recover() {
        audioQueue.async { [self] in
            guard lock.withLock({ wanted }), !engine.isRunning else { return }
            do {
                try startEngine()
                timeline.mark("microphone-restarted")
            } catch {
                timeline.mark("microphone-restart-failed", error.localizedDescription)
            }
        }
    }

    /// Same session as Operator's iPhone app, so Bluetooth and the speaker behave the same.
    private func setCategory() throws {
        let session = AVAudioSession.sharedInstance()
        let options: AVAudioSession.CategoryOptions = [.mixWithOthers, .defaultToSpeaker, .allowBluetoothHFP]
        if session.category != .playAndRecord || session.mode != .default || session.categoryOptions != options {
            try session.setCategory(.playAndRecord, mode: .default, options: options)
        }
        if !session.allowHapticsAndSystemSoundsDuringRecording {
            try session.setAllowHapticsAndSystemSoundsDuringRecording(true)
        }
    }

    /// Also restarts a stopped engine: the input's format can differ after a route change.
    private func startEngine() throws {
        try setCategory()
        try AVAudioSession.sharedInstance().setActive(true)
        let input = engine.inputNode
        let inputFormat = input.outputFormat(forBus: 0)
        guard inputFormat.sampleRate > 0, inputFormat.channelCount > 0,
              let converter = AVAudioConverter(from: inputFormat, to: format) else {
            throw VoiceError("No microphone input is available.")
        }
        let box = ConverterBox(converter)
        input.removeTap(onBus: 0)
        input.installTap(onBus: 0, bufferSize: 1024, format: inputFormat) { [weak self] buffer, _ in
            self?.receive(buffer, box.converter)
        }
        engine.prepare()
        try engine.start()
    }

    private func receive(_ buffer: AVAudioPCMBuffer, _ converter: AVAudioConverter) {
        let capacity = AVAudioFrameCount(Double(buffer.frameLength) * StreamProtocol.rate / buffer.format.sampleRate) + 16
        guard let output = AVAudioPCMBuffer(pcmFormat: format, frameCapacity: capacity) else { return }
        var fed = false
        var error: NSError?
        converter.convert(to: output, error: &error) { _, status in
            if fed { status.pointee = .noDataNow; return nil }
            fed = true
            status.pointee = .haveData
            return buffer
        }
        guard error == nil, let channel = output.int16ChannelData?[0], output.frameLength > 0 else { return }
        let chunk = Array(UnsafeBufferPointer(start: channel, count: Int(output.frameLength)))
        // The sink runs under the lock, so `stop` returns only after the last chunk went in.
        lock.withLock {
            guard capturing else { return }
            timeline.markOnce("first-audio")
            sink(chunk)
        }
    }
}

// MARK: One dictation's capture

/// The microphone, the stream and the file of one Operator dictation. Not signed in: it records
/// the same, with no stream, and the stop shows the sign-in hint.
final class OperatorCapture: @unchecked Sendable {
    let route: VoiceRoute
    let stream: DictationStream?
    private let timeline: DictationTimeline
    private let writer: PCMFileWriter
    private var recorder: StreamRecorder?
    private let lock = NSLock()
    private var total = 0

    init(route: VoiceRoute, timeline: DictationTimeline, onEarlyText: @escaping @Sendable (String) -> Void) throws {
        self.route = route
        self.timeline = timeline
        writer = try PCMFileWriter()
        if case let .operator(speech, token) = route, let request = StreamProtocol.request(speech: speech, token: token) {
            stream = DictationStream(request: request, timeline: timeline, onEarlyText: onEarlyText)
        } else {
            stream = nil
        }
        recorder = StreamRecorder(timeline: timeline) { [weak self] chunk in self?.receive(chunk) }
    }

    /// Opens the microphone in the background. `done` gets the error if it cannot open.
    func start(_ done: @escaping @Sendable (Error?) -> Void) {
        recorder?.start(done)
    }

    /// Stops the microphone. Returns how many samples were captured; no more come after this.
    func endCapture() -> Int {
        recorder?.stop()
        recorder = nil
        return lock.withLock { total }
    }

    /// The WAV file with every captured sample, for the upload. Call after `endCapture`.
    func closeFile() -> URL { writer.close() }

    /// Removes the file. Call when the dictation is over.
    func discardFile() { writer.discard() }

    /// Stops everything and removes the file.
    func cancel() {
        recorder?.stop()
        recorder = nil
        stream?.cancel()
        writer.discard()
    }

    private func receive(_ chunk: [Int16]) {
        lock.withLock { total += chunk.count }
        writer.append(chunk)
        stream?.append(chunk)
    }
}
