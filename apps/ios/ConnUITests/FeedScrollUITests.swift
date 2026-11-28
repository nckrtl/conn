import XCTest

/// The thread feed's scroll behaviour against `scripts/feed-fixture.mjs`
/// (`PORT=47941 bun apps/ios/scripts/feed-fixture.mjs .` from the repo root). Skipped unless
/// `CONN_FEED_SERVER` is set (`TEST_RUNNER_CONN_FEED_SERVER=http://127.0.0.1:47941`).
/// The app runs with `CONN_FEED_PROBE`, which exposes the feed's offset, distance to the end and
/// pin as the accessibility value of `thread.feedProbe`.
@MainActor
final class FeedScrollUITests: XCTestCase {
    private var server = ""
    private let app = XCUIApplication()
    private var evidence: URL?

    override func setUp() async throws {
        continueAfterFailure = false
        let env = ProcessInfo.processInfo.environment
        guard let server = env["CONN_FEED_SERVER"], !server.isEmpty else {
            throw XCTSkip("Set TEST_RUNNER_CONN_FEED_SERVER to the feed fixture")
        }
        self.server = server
        evidence = env["CONN_FEED_EVIDENCE"].map { URL(fileURLWithPath: $0) }
        _ = try get("reset")
        app.launchEnvironment["CONN_TEST_APPEARANCE"] = env["CONN_PROOF_APPEARANCE"] ?? "dark"
        app.launchEnvironment["CONN_TEST_TASK_GATEWAY"] = server
        app.launchEnvironment["CONN_FEED_PROBE"] = "1"
        app.launchEnvironment["CONN_TEST_SAVED_SESSION"] =
            #"{"serverURL":"\#(server)","bearerToken":"fixture","environmentId":"primary"}"#
        app.launchArguments = ["--reset-session"]
    }

    // MARK: - Helpers

    @discardableResult
    private func get(_ path: String) throws -> Data {
        try Data(contentsOf: XCTUnwrap(URL(string: server + "/" + path)))
    }

    private func wait(_ seconds: Double) {
        RunLoop.current.run(until: Date().addingTimeInterval(seconds))
    }

    private func shot(_ name: String) {
        let screenshot = app.screenshot()
        let attachment = XCTAttachment(screenshot: screenshot)
        attachment.name = name
        attachment.lifetime = .keepAlways
        add(attachment)
        if let evidence {
            try? screenshot.pngRepresentation.write(to: evidence.appendingPathComponent(name + ".png"))
        }
    }

    private struct Probe {
        let y: Double
        let distance: Double
        let pinned: Bool
        let rows: Int
        let frames: Int
        let hitches: Int
    }

    private var probeElement: XCUIElement { app.descendants(matching: .any)["thread.feedProbe"] }

    private func probe() throws -> Probe {
        let value = try XCTUnwrap(probeElement.value as? String, "feed probe")
        var fields: [String: Double] = [:]
        for pair in value.split(separator: " ") {
            let parts = pair.split(separator: "=")
            if parts.count == 2 { fields[String(parts[0])] = Double(parts[1]) }
        }
        return Probe(y: try XCTUnwrap(fields["y"]), distance: try XCTUnwrap(fields["dist"]),
                     pinned: fields["pin"] == 1, rows: Int(fields["n"] ?? 0),
                     frames: Int(fields["fr"] ?? 0), hitches: Int(fields["hitch"] ?? 0))
    }

    /// How many times the jump circle came in since launch.
    private func jumpShows() throws -> Int? {
        try XCTUnwrap(probeElement.value as? String).components(separatedBy: " js=").last.flatMap { Int($0) }
    }

    private func openThread(_ id: String) {
        app.launch()
        let row = app.descendants(matching: .any)["inbox.thread.\(id)"]
        XCTAssertTrue(row.waitForExistence(timeout: 30), "inbox row \(id)")
        row.tap()
    }

    private func waitForRows() throws {
        XCTAssertTrue(probeElement.waitForExistence(timeout: 10), "feed probe")
        let deadline = Date().addingTimeInterval(10)
        while try probe().rows < 10, Date() < deadline { wait(0.2) }
        XCTAssertGreaterThanOrEqual(try probe().rows, 10, "the feed loaded")
    }

    private func text(_ prefix: String) -> XCUIElement {
        app.staticTexts.containing(NSPredicate(format: "label BEGINSWITH %@", prefix)).firstMatch
    }

    private var composer: XCUIElement { app.descendants(matching: .any)["thread.composer"].firstMatch }
    private var jump: XCUIElement { app.buttons["thread.scrollToEnd"] }

    /// A slow drag that ends without a fling: the feed moves by about the finger's distance.
    private func drag(from: Double, to: Double, hold: Double = 0.3) {
        let start = app.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: from))
        let end = app.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: to))
        start.press(forDuration: 0.05, thenDragTo: end, withVelocity: .slow, thenHoldForDuration: hold)
    }

    /// The streaming reply's last line sits above the composer.
    private func assertLastLineVisible(_ line: Int, _ message: String) {
        // The reply's paragraphs may read as one text: match the line inside it.
        let last = app.staticTexts.containing(NSPredicate(format: "label CONTAINS %@", "Streamed line \(line):")).firstMatch
        if !last.waitForExistence(timeout: 3) {
            print("FEEDPROOF texts=\(app.staticTexts.allElementsBoundByIndex.suffix(6).map { $0.label.prefix(120) })")
        }
        XCTAssertTrue(last.waitForExistence(timeout: 3), "line \(line) exists: \(message)")
        XCTAssertLessThanOrEqual(last.frame.maxY, composer.frame.minY + 1, "line \(line) above the composer: \(message)")
        XCTAssertGreaterThan(last.frame.minY, 100, "line \(line) on screen: \(message)")
    }

    // MARK: - 1. Opening

    /// A thread opens at its end, and nothing moves on screen while it settles.
    func test1OpensAtTheEndWithoutScrolling() throws {
        openThread("feed")
        let last = text("Reply 30.")
        XCTAssertTrue(last.waitForExistence(timeout: 10), "last reply")
        var positions: [Double] = []
        var samples: [Probe] = []
        for _ in 0..<12 {
            positions.append(last.frame.minY)
            samples.append(try probe())
            wait(0.15)
        }
        shot("feed-1-open")
        print("FEEDPROOF open positions=\(positions) dist=\(samples.map(\.distance))")
        XCTAssertTrue(samples.allSatisfy { $0.distance <= 1 }, "at the end in every sample: \(samples.map(\.distance))")
        XCTAssertTrue(samples.allSatisfy(\.pinned), "pinned")
        XCTAssertLessThanOrEqual((positions.max() ?? 0) - (positions.min() ?? 0), 1, "the last reply never moved: \(positions)")
        XCTAssertLessThanOrEqual(last.frame.maxY, composer.frame.minY + 1, "the last reply sits above the composer")
        XCTAssertFalse(jump.exists, "no jump button at the end")

        // Back, then open again: the same, from the cached feed.
        app.buttons["Back"].firstMatch.tap()
        wait(1)
        app.descendants(matching: .any)["inbox.thread.feed"].tap()
        XCTAssertTrue(last.waitForExistence(timeout: 10))
        positions = []
        for _ in 0..<8 {
            positions.append(last.frame.minY)
            XCTAssertLessThanOrEqual(try probe().distance, 1, "reopened at the end")
            wait(0.15)
        }
        XCTAssertLessThanOrEqual((positions.max() ?? 0) - (positions.min() ?? 0), 1, "reopen: the last reply never moved: \(positions)")
    }

    /// A thread that opens at its end never shows the jump circle, not even for a moment while its
    /// rows and images settle to their measured heights. The probe counts every time the circle
    /// comes in, so a flash between samples still fails.
    func test1bOpenNeverFlashesJump() throws {
        continueAfterFailure = true
        for id in ["feed", "tall"] {
            openThread(id)
            XCTAssertTrue(probeElement.waitForExistence(timeout: 10), "feed probe")
            var seen: [Double] = []
            let start = Date()
            while Date().timeIntervalSince(start) < 2 {
                if jump.exists { seen.append(Date().timeIntervalSince(start)) }
                wait(0.05)
            }
            let state = try probe()
            let shows = try jumpShows()
            print("FEEDPROOF flash \(id) seen=\(seen) shows=\(shows ?? -1) dist=\(state.distance) n=\(state.rows) images=\(app.buttons.matching(NSPredicate(format: "label BEGINSWITH 'tall-'")).count)")
            XCTAssertLessThanOrEqual(state.distance, 1, "\(id): at the end")
            XCTAssertTrue(seen.isEmpty, "\(id): the jump circle showed while opening at \(seen)")
            XCTAssertEqual(shows, 0, "\(id): the jump circle came in \(shows ?? -1) times while opening")
            shot("feed-1b-open-\(id)")

            // Back, then open again from the cached feed.
            app.buttons["Back"].firstMatch.tap()
            wait(1)
            app.descendants(matching: .any)["inbox.thread.\(id)"].tap()
            seen = []
            let again = Date()
            while Date().timeIntervalSince(again) < 1.5 {
                if jump.exists { seen.append(Date().timeIntervalSince(again)) }
                wait(0.05)
            }
            let reopened = try jumpShows()
            print("FEEDPROOF flash \(id) reopen seen=\(seen) shows=\(reopened ?? -1)")
            XCTAssertTrue(seen.isEmpty, "\(id): the jump circle showed on reopen at \(seen)")
            XCTAssertEqual(reopened, shows, "\(id): the jump circle came in on reopen")
            app.terminate()
        }
    }

    // MARK: - 2. Pinned growth

    /// At the end, a streaming reply grows upward and the end stays in view.
    func test2PinnedStreamGrowsUpward() throws {
        openThread("stream")
        try waitForRows()
        wait(1)
        XCTAssertLessThanOrEqual(try probe().distance, 1, "opens at the end")
        var lines = 0
        for step in 0..<8 {
            lines += 3
            try get("grow?lines=3")
            wait(0.4)
            let state = try probe()
            XCTAssertTrue(state.pinned, "still pinned after step \(step)")
            XCTAssertLessThanOrEqual(state.distance, 1, "at the end after step \(step): \(state.distance)")
            assertLastLineVisible(lines, "step \(step)")
        }
        // A new row under the streaming one, too.
        try get("add")
        wait(0.5)
        XCTAssertLessThanOrEqual(try probe().distance, 1, "at the end after a new row")
        let extra = text("Extra reply 1:")
        XCTAssertTrue(extra.waitForExistence(timeout: 3))
        XCTAssertLessThanOrEqual(extra.frame.maxY, composer.frame.minY + 1, "the new row is in view")
        XCTAssertEqual(try jumpShows(), 0, "streaming at the end never showed the jump circle")
        shot("feed-2-pinned-growth")
    }

    // MARK: - 3. Scrolled up

    /// Scrolled up, growth below never moves what is read, and the feed never snaps back.
    func test3ScrolledUpGrowthNeverMovesTheReader() throws {
        openThread("stream")
        try waitForRows()
        try get("grow?lines=4")
        wait(0.6)
        for _ in 0..<2 { drag(from: 0.3, to: 0.75) }
        wait(1)
        let before = try probe()
        XCTAssertFalse(before.pinned, "unpinned after scrolling up")
        XCTAssertGreaterThan(before.distance, 100, "well above the end")
        let reading = app.staticTexts.containing(NSPredicate(format: "label BEGINSWITH 'Question'")).allElementsBoundByIndex
            .first { $0.isHittable && $0.frame.minY > 150 }
        let anchor = try XCTUnwrap(reading, "a message in view")
        let label = anchor.label
        let frame = anchor.frame
        shot("feed-3-before")

        for step in 0..<6 {
            try get(step == 3 ? "add" : "grow?lines=5")
            wait(0.4)
            let state = try probe()
            XCTAssertEqual(state.y, before.y, accuracy: 0.5, "offset unchanged after step \(step)")
            XCTAssertFalse(state.pinned, "still unpinned after step \(step)")
            let now = app.staticTexts[label].firstMatch.frame
            XCTAssertEqual(now.minY, frame.minY, accuracy: 0.5, "the message didn't move after step \(step)")
        }
        XCTAssertTrue(jump.exists, "jump button while scrolled up")
        shot("feed-3-after")

        // Content streams in while the finger drags up: the feed never snaps back to the end.
        let server = self.server
        let streamer = Thread {
            for _ in 0..<8 {
                _ = try? Data(contentsOf: URL(string: server + "/grow?lines=2")!)
                Thread.sleep(forTimeInterval: 0.15)
            }
        }
        streamer.start()
        drag(from: 0.35, to: 0.6, hold: 1.2)
        wait(0.8)
        let after = try probe()
        XCTAssertFalse(after.pinned, "not re-pinned by the stream")
        XCTAssertGreaterThan(after.distance, before.distance, "further from the end, not snapped back")
    }

    // MARK: - 4. Jump to latest

    /// The jump button shows beyond 100 pt from the end and hides within it; a tap goes to the
    /// end; scrolling back down by hand hides it too. Its coming and going never moves the feed.
    func test4JumpButton() throws {
        openThread("feed")
        try waitForRows()
        wait(1)
        XCTAssertFalse(jump.exists, "hidden at the end")

        // A short drag: within 100 pt, still hidden.
        drag(from: 0.5, to: 0.58)
        wait(0.8)
        var state = try probe()
        print("FEEDPROOF shortDrag dist=\(state.distance)")
        XCTAssertGreaterThan(state.distance, 24)
        XCTAssertLessThanOrEqual(state.distance, 100)
        XCTAssertFalse(jump.exists, "hidden within 100 pt (\(state.distance))")

        // Further up: shown.
        drag(from: 0.5, to: 0.62)
        wait(0.8)
        state = try probe()
        print("FEEDPROOF longerDrag dist=\(state.distance)")
        XCTAssertGreaterThan(state.distance, 100)
        XCTAssertTrue(jump.waitForExistence(timeout: 2), "shown beyond 100 pt (\(state.distance))")
        // The button coming in doesn't move the feed (no inset feedback).
        var offsets: [Double] = []
        for _ in 0..<8 { offsets.append(try probe().y); wait(0.1) }
        XCTAssertLessThanOrEqual((offsets.max() ?? 0) - (offsets.min() ?? 0), 0.5, "steady with the button shown: \(offsets)")
        XCTAssertTrue(jump.exists, "still shown")
        shot("feed-4-jump-shown")

        // Tap: to the end, and the button goes.
        for _ in 0..<3 { drag(from: 0.3, to: 0.8) }
        wait(0.8)
        jump.tap()
        wait(1.2)
        state = try probe()
        XCTAssertLessThanOrEqual(state.distance, 1, "at the end after the tap")
        XCTAssertTrue(state.pinned, "pinned after the tap")
        XCTAssertFalse(jump.exists, "hidden after the tap")
        shot("feed-4-after-tap")

        // Up again, then back down by hand.
        for _ in 0..<2 { drag(from: 0.3, to: 0.8) }
        XCTAssertTrue(jump.waitForExistence(timeout: 2), "shown again")
        for _ in 0..<4 { app.swipeUp(velocity: .fast); wait(0.4) }
        wait(1.2)
        state = try probe()
        XCTAssertLessThanOrEqual(state.distance, 1, "back at the end by hand")
        XCTAssertTrue(state.pinned, "pinned again once settled at the end")
        XCTAssertFalse(jump.exists, "hidden after scrolling back by hand")
    }

    // MARK: - 5. Working for

    private func workingSeconds() -> Int? {
        let fold = app.descendants(matching: .any)["thread.workingFold"]
        guard fold.exists else { return nil }
        let label = fold.label
        guard let range = label.range(of: "Working for ") else { return nil }
        var total = 0
        for part in label[range.upperBound...].split(separator: " ") {
            let number = Int(part.dropLast()) ?? 0
            switch part.last {
            case "h": total += number * 3600
            case "m": total += number * 60
            case "s": total += number
            default: break
            }
        }
        return total
    }

    /// The "Working for" count never restarts while the feed scrolls its row away and back.
    func test5WorkingTimerSurvivesScrolling() throws {
        openThread("stream")
        try waitForRows()
        wait(1)
        let first = try XCTUnwrap(workingSeconds(), "Working for row")
        XCTAssertGreaterThanOrEqual(first, 60, "counts from the run's start, not the open")
        var last = first
        for round in 0..<3 {
            for _ in 0..<3 { drag(from: 0.3, to: 0.8) }
            wait(0.5)
            XCTAssertNil(workingSeconds(), "scrolled out of view in round \(round)")
            for _ in 0..<5 { app.swipeUp(velocity: .fast); wait(0.3) }
            wait(1)
            let now = try XCTUnwrap(workingSeconds(), "back in view in round \(round)")
            print("FEEDPROOF working round=\(round) seconds=\(now)")
            XCTAssertGreaterThanOrEqual(now, last, "never restarted (round \(round): \(now) after \(last))")
            last = now
        }
        XCTAssertGreaterThan(last, first, "it kept counting")
    }

    // MARK: - 6. Taps

    /// A tap on a message reveals nothing; a long press opens its menu (time, Copy, Select text).
    /// The cell keeps the SwiftUI gestures.
    func test6TapAndLongPress() throws {
        openThread("feed")
        try waitForRows()
        wait(1)
        let reply = text("Reply 30.")
        XCTAssertTrue(reply.waitForExistence(timeout: 5))
        reply.tap()
        wait(0.6)
        XCTAssertFalse(app.buttons["Copy message"].exists, "a tap reveals nothing")
        XCTAssertLessThanOrEqual(try probe().distance, 1, "still pinned to the end")
        reply.press(forDuration: 1.2)
        XCTAssertTrue(app.buttons["Copy"].waitForExistence(timeout: 3), "the long press opens the menu")
        XCTAssertTrue(app.buttons["Select text"].exists, "Select text in the menu")
        shot("feed-6-menu")
    }

    // MARK: - 7. Keyboard

    /// At the end, the keyboard opening and closing keeps the end in view.
    func test7KeyboardKeepsTheEnd() throws {
        openThread("stream")
        try waitForRows()
        try get("grow?lines=2")
        wait(1)
        let field = app.textViews.firstMatch.exists ? app.textViews.firstMatch : app.textFields.firstMatch
        field.tap()
        XCTAssertTrue(app.keyboards.firstMatch.waitForExistence(timeout: 5), "keyboard")
        wait(1)
        var state = try probe()
        XCTAssertLessThanOrEqual(state.distance, 1, "at the end with the keyboard up")
        XCTAssertTrue(state.pinned)
        assertLastLineVisible(2, "keyboard up")
        XCTAssertLessThanOrEqual(composer.frame.maxY, app.keyboards.firstMatch.frame.minY + 1, "composer above the keyboard")
        shot("feed-7-keyboard-up")

        // Streaming with the keyboard up stays pinned.
        try get("grow?lines=3")
        wait(0.5)
        XCTAssertLessThanOrEqual(try probe().distance, 1, "pinned while streaming with the keyboard up")
        assertLastLineVisible(5, "keyboard up, streaming")

        // A tap on the feed closes the keyboard; the end stays.
        app.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.3)).tap()
        XCTAssertTrue(app.keyboards.firstMatch.waitForNonExistence(timeout: 5), "keyboard closed")
        wait(0.8)
        state = try probe()
        XCTAssertLessThanOrEqual(state.distance, 1, "at the end after the keyboard closed")
        assertLastLineVisible(5, "keyboard down")
        shot("feed-7-keyboard-down")
    }

    // MARK: - 9. Streaming frame rate

    /// While the reply streams (a snapshot every 100 ms), the feed keeps drawing frames on time.
    /// The probe counts display-link frames that came late by more than half a frame.
    func test9StreamingKeepsFrames() throws {
        openThread("stream")
        try waitForRows()
        wait(1.5)
        let server = self.server
        let start = try probe()
        let streamer = Thread {
            for _ in 0..<40 {
                _ = try? Data(contentsOf: URL(string: server + "/grow?lines=1")!)
                Thread.sleep(forTimeInterval: 0.1)
            }
        }
        streamer.start()
        wait(5)
        let end = try probe()
        let frames = end.frames - start.frames
        let hitches = end.hitches - start.hitches
        print("FEEDPROOF streaming frames=\(frames) hitches=\(hitches) ratio=\(Double(hitches) / Double(max(1, frames)))")
        XCTAssertLessThanOrEqual(end.distance, 1, "pinned through the stream")
        XCTAssertGreaterThan(frames, 200, "the display link kept running")
        XCTAssertLessThan(Double(hitches) / Double(max(1, frames)), 0.05, "fewer than 5% late frames")
    }
}
