import XCTest
@testable import Conn

/// Pure logic of the streamed Operator dictation. Message shapes are those of Operator's iPhone app
/// (`DictationStream`) and the server's `/v1/stream` (openai_api.py).
final class DictationStreamTests: XCTestCase {
    // MARK: Framing

    private func samples(_ count: Int, from start: Int = 0) -> [Int16] { (0..<count).map { Int16(truncatingIfNeeded: start + $0) } }

    private func values(_ message: Data) -> [Int16] {
        message.withUnsafeBytes { Array($0.bindMemory(to: Int16.self)) }
    }

    func testAMessageIsOneHundredMillisecondsOfSixteenKilohertzInt16() {
        XCTAssertEqual(StreamFraming.messageBytes, 3200)
        XCTAssertEqual(StreamFraming.messageBytes / 2, Int(StreamProtocol.rate / 10))
    }

    func testConnectedFramingCutsExactMessagesAndKeepsTheRest() {
        var framing = StreamFraming()
        _ = framing.connect()
        XCTAssertTrue(framing.append(samples(1000)).isEmpty)
        let out = framing.append(samples(2000, from: 1000))
        XCTAssertEqual(out.count, 1)
        XCTAssertEqual(out[0].count, 3200)
        XCTAssertEqual(values(out[0]), samples(1600))
        XCTAssertEqual(framing.remainder.count, 2800)
        XCTAssertEqual(framing.samplesSent, 1600)
    }

    func testOneBigChunkMakesSeveralMessages() {
        var framing = StreamFraming()
        _ = framing.connect()
        let out = framing.append(samples(4000))
        XCTAssertEqual(out.map(\.count), [3200, 3200])  // 1600 + 1600 samples, 800 left over
        XCTAssertEqual(framing.remainder.count, 1600)
    }

    func testSamplesBeforeTheSocketOpensAreHeldAndFlushedInOrder() {
        var framing = StreamFraming()
        XCTAssertTrue(framing.append(samples(1600)).isEmpty)
        XCTAssertTrue(framing.append(samples(1600, from: 1600)).isEmpty)
        XCTAssertTrue(framing.append(samples(800, from: 3200)).isEmpty)
        XCTAssertEqual(framing.held.count, 2)
        XCTAssertEqual(framing.samplesSent, 0)

        let flushed = framing.connect()
        XCTAssertEqual(flushed.count, 2)
        XCTAssertEqual(values(flushed[0]), samples(1600))
        XCTAssertEqual(values(flushed[1]), samples(1600, from: 1600))
        XCTAssertEqual(framing.samplesSent, 3200)
        XCTAssertTrue(framing.held.isEmpty)

        // After the open, new messages go out straight away, after the flushed ones.
        let next = framing.append(samples(1000, from: 4000))
        XCTAssertEqual(next.count, 1)
        XCTAssertEqual(values(next[0]), samples(1600, from: 3200))
    }

    func testFinishSendsTheShortLastMessageSoTheCountMatches() {
        var framing = StreamFraming()
        _ = framing.connect()
        _ = framing.append(samples(1700))
        let last = framing.finish()
        XCTAssertEqual(last.count, 1)
        XCTAssertEqual(values(last[0]), samples(100, from: 1600))
        XCTAssertEqual(framing.samplesSent, 1700)
        XCTAssertTrue(framing.finish().isEmpty)
    }

    func testFinishBeforeConnectingHoldsTheLastMessageToo() {
        var framing = StreamFraming()
        _ = framing.append(samples(1700))
        XCTAssertTrue(framing.finish().isEmpty)
        XCTAssertEqual(framing.held.count, 2)
        let flushed = framing.connect()
        XCTAssertEqual(flushed.map(\.count), [3200, 200])
        XCTAssertEqual(framing.samplesSent, 1700)
    }

    // MARK: Timeout and messages

    func testAnswerTimeoutIsFourSecondsPlusOnePercentOfTheRecording() {
        XCTAssertEqual(StreamProtocol.answerTimeout(samples: 0), 4, accuracy: 0.0001)
        XCTAssertEqual(StreamProtocol.answerTimeout(samples: 16_000 * 10), 4.1, accuracy: 0.0001)
        XCTAssertEqual(StreamProtocol.answerTimeout(samples: 16_000 * 600), 10, accuracy: 0.0001)
    }

    private func object(_ text: String) throws -> [String: Any] {
        try XCTUnwrap(JSONSerialization.jsonObject(with: Data(text.utf8)) as? [String: Any])
    }

    func testStartMessageAsksForNoLiveText() throws {
        let start = try object(StreamProtocol.startMessage(pause: 0.25))
        XCTAssertEqual(start["type"] as? String, "start")
        XCTAssertEqual(start["pause"] as? Double, 0.25)
        XCTAssertEqual(start["live"] as? Bool, false)
        XCTAssertNil(start["language"])
        let live = try object(StreamProtocol.startMessage(pause: 0.5, language: "nl", live: true))
        XCTAssertEqual(live["language"] as? String, "nl")
        XCTAssertNil(live["live"])
    }

    func testStopMessageCarriesTheSampleCount() throws {
        let stop = try object(StreamProtocol.stopMessage(samples: 48_000))
        XCTAssertEqual(stop["type"] as? String, "stop")
        XCTAssertEqual(stop["samples"] as? Int, 48_000)
        XCTAssertEqual(stop.count, 2)
        XCTAssertEqual(try object(StreamProtocol.stopMessage(samples: 1, language: "en"))["language"] as? String, "en")
    }

    func testStreamRequestIsAWebSocketOnTheSpeechAddressWithTheBearerToken() throws {
        let plain = try XCTUnwrap(StreamProtocol.request(speech: "http://10.44.0.7:12331", token: "t"))
        XCTAssertEqual(plain.url?.absoluteString, "ws://10.44.0.7:12331/v1/stream")
        XCTAssertEqual(plain.value(forHTTPHeaderField: "Authorization"), "Bearer t")
        let secure = try XCTUnwrap(StreamProtocol.request(speech: "https://speech.example.com/api/", token: "t"))
        XCTAssertEqual(secure.url?.absoluteString, "wss://speech.example.com/api/v1/stream")
        XCTAssertNil(StreamProtocol.request(speech: "", token: "t"))
    }

    // MARK: Replies

    private func reply(_ json: String) -> StreamReply? { StreamProtocol.reply(from: Data(json.utf8)) }

    func testPhraseReply() {
        XCTAssertEqual(
            reply(#"{"type":"partial","text":"hello there","language":"en","seq":2,"samples":32000}"#),
            .partial(text: "hello there", language: "en", seq: 2, samples: 32000)
        )
    }

    func testTailReplyWithTheWholeText() {
        XCTAssertEqual(
            reply(#"{"type":"tail","tail":"and more","text":"hello there and more","language":"en","partials":1,"seconds":0.2,"layout":false,"layoutRequested":false}"#),
            .tail(StreamTail(text: "and more", language: "en", partials: 1, whole: "hello there and more"))
        )
        XCTAssertEqual(
            reply(#"{"type":"tail","tail":"and more","language":"en","partials":1}"#),
            .tail(StreamTail(text: "and more", language: "en", partials: 1, whole: nil))
        )
    }

    func testFinalReplyAndErrorAndTheTypesToIgnore() {
        XCTAssertEqual(
            reply(#"{"type":"result","text":"hello there and more","language":"en","duration":3.1,"tail":"and more","partials":1}"#),
            .result(text: "hello there and more", language: "en", tail: "and more", partials: 1)
        )
        XCTAssertEqual(
            reply(#"{"type":"error","code":"audio-missing","message":"3 of 5 samples arrived"}"#),
            .error("3 of 5 samples arrived")
        )
        XCTAssertEqual(reply(#"{"type":"ready"}"#), .ready)
        XCTAssertNil(reply(#"{"type":"something-new"}"#))
        XCTAssertNil(reply("not json"))
        XCTAssertNil(reply(#"{"text":"no type"}"#))
    }

    // MARK: Text at the tail

    func testEarlyTextIsTheServersWholeText() {
        let tail = StreamTail(text: "and more", language: nil, partials: 1, whole: " hello there and more ")
        XCTAssertEqual(StreamProtocol.earlyText(tail: tail, phrases: ["hello there"]), "hello there and more")
    }

    func testEarlyTextOfAnOlderServerJoinsThePhrasesAndTheTail() {
        let tail = StreamTail(text: " and more", language: nil, partials: 2, whole: nil)
        XCTAssertEqual(StreamProtocol.earlyText(tail: tail, phrases: ["one", " two "]), "one two and more")
    }

    func testAnEmptyTailWaitsForTheFinalText() {
        XCTAssertNil(StreamProtocol.earlyText(tail: StreamTail(text: "", language: nil, partials: 1, whole: ""), phrases: []))
        XCTAssertNil(StreamProtocol.earlyText(tail: StreamTail(text: " ", language: nil, partials: 0, whole: nil), phrases: []))
    }

    // MARK: Fallback

    func testTheFinalTextIsUsedWhenTheStreamAnswered() {
        XCTAssertEqual(DictationFallback.afterStream(earlyInserted: false, streamSucceeded: true), .insertStreamText)
    }

    func testAFailedStreamUploadsTheKeptRecording() {
        XCTAssertEqual(DictationFallback.afterStream(earlyInserted: false, streamSucceeded: false), .upload)
    }

    func testNothingIsUploadedOnceTheTailWasInserted() {
        XCTAssertEqual(DictationFallback.afterStream(earlyInserted: true, streamSucceeded: false), .skip)
        XCTAssertEqual(DictationFallback.afterStream(earlyInserted: true, streamSucceeded: true), .skip)
    }

    // MARK: WAV and log

    func testWavHeaderDescribesSixteenKilohertzMonoPCM() {
        let header = WavFile.header(sampleCount: 16_000)
        XCTAssertEqual(header.count, WavFile.headerBytes)
        XCTAssertEqual(String(decoding: header.prefix(4), as: UTF8.self), "RIFF")
        XCTAssertEqual(String(decoding: header[8..<16], as: UTF8.self), "WAVEfmt ")
        func u32(_ at: Int) -> UInt32 {
            var value: UInt32 = 0
            for i in 0..<4 { value |= UInt32(header[at + i]) << UInt32(8 * i) }
            return value
        }
        XCTAssertEqual(u32(4), 36 + 32_000)
        XCTAssertEqual(u32(24), 16_000)
        XCTAssertEqual(u32(28), 32_000)
        XCTAssertEqual(u32(40), 32_000)
    }

    func testTimingLinesCarryMillisecondsSinceTheTap() {
        let timeline = DictationTimeline(now: 100)
        XCTAssertEqual(timeline.milliseconds(now: 100.1234), 123)
        XCTAssertEqual(DictationTimeline.line(id: "ab12", ms: 123, event: "recording"), "[ab12] +123ms recording")
        XCTAssertEqual(
            DictationTimeline.line(id: "ab12", ms: 4, event: "done", detail: "engine=operator path=stream"),
            "[ab12] +4ms done engine=operator path=stream"
        )
    }
}
