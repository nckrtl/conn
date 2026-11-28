import XCTest

/// Thread pipeline checks against the scripted mock server (`cargo run -p conn-ffi --example
/// ios_thread_mock -- <port> <skew_ms>`). Skipped unless `CONN_MOCK_PORT` is set.
@MainActor
final class ConnPipelineUITests: XCTestCase {
    private var port = ""
    private var app = XCUIApplication()

    override func setUpWithError() throws {
        continueAfterFailure = false
        guard let port = ProcessInfo.processInfo.environment["CONN_MOCK_PORT"], !port.isEmpty else {
            throw XCTSkip("Set CONN_MOCK_PORT to run against the mock server")
        }
        self.port = port
        app.launchEnvironment["CONN_TEST_SAVED_SESSION"] =
            #"{"serverURL":"http://127.0.0.1:\#(port)","bearerToken":"mock-token","environmentId":"mock-env"}"#
        app.launchEnvironment["CONN_BODY_COUNTS"] = "1"
        app.launchArguments = ["--reset-session"]
    }

    private func control(_ path: String) throws {
        let url = try XCTUnwrap(URL(string: "http://127.0.0.1:\(port)/control/\(path)"))
        let done = expectation(description: path)
        URLSession.shared.dataTask(with: url) { _, _, _ in done.fulfill() }.resume()
        wait(for: [done], timeout: 5)
    }

    private func shot(_ name: String) {
        let attachment = XCTAttachment(screenshot: app.screenshot())
        attachment.name = name
        attachment.lifetime = .keepAlways
        add(attachment)
    }

    private func mark(_ phase: String) {
        print("PIPELINE-PHASE \(phase) \(Date().timeIntervalSince1970)")
    }

    private func openThread(_ id: String) {
        app.launch()
        let row = app.descendants(matching: .any)["inbox.thread.\(id)"]
        XCTAssertTrue(row.waitForExistence(timeout: 30), "inbox row \(id)")
        row.tap()
    }

    private var field: XCUIElement {
        let view = app.textViews.firstMatch
        return view.exists ? view : app.textFields.firstMatch
    }

    private func rows(_ text: String) -> Int {
        app.staticTexts.matching(NSPredicate(format: "label == %@", text)).count
    }

    private func fieldValue() -> String {
        (field.value as? String) ?? ""
    }

    /// The draft clears and one row shows at once, while the server's answer and its own row take
    /// seconds; the keyboard stays up. Then a refused reply comes back into the draft after what
    /// was typed meanwhile.
    func testAReplyShowsAtOnceAndLeavesExactlyOneRow() throws {
        try control("delays?ack=3000&echo=1500&fail=0")
        openThread("mock-long")
        XCTAssertTrue(field.waitForExistence(timeout: 20))
        field.tap()
        let text = "Pipeline check one"
        field.typeText(text)
        app.buttons["Send"].tap()
        let sentAt = Date()
        XCTAssertTrue(app.staticTexts[text].waitForExistence(timeout: 1), "the pending row")
        let shownAfter = Date().timeIntervalSince(sentAt)
        XCTAssertFalse(fieldValue().contains(text), "the draft cleared at once")
        XCTAssertTrue(app.keyboards.firstMatch.exists, "the keyboard stays up")
        shot("send-pending")
        print("PIPELINE-RESULT pending_row_after_s=\(shownAfter)")
        // Echo at 1.5 s, acknowledgement at 3 s.
        for second in 1...5 {
            Thread.sleep(forTimeInterval: 1)
            XCTAssertEqual(rows(text), 1, "one row at \(second) s")
        }
        shot("send-echoed")

        // The acknowledgement before the echo.
        try control("delays?ack=500&echo=2500&fail=0")
        let second = "Pipeline check two"
        field.typeText(second)
        app.buttons["Send"].tap()
        XCTAssertTrue(app.staticTexts[second].waitForExistence(timeout: 1))
        for moment in 1...4 {
            Thread.sleep(forTimeInterval: 1)
            XCTAssertEqual(rows(second), 1, "one row at \(moment) s")
        }

        // Refused: the row goes and the text is back, beside what was typed meanwhile.
        // The refusal comes after the typing below has finished.
        try control("delays?ack=4000&echo=0&fail=1")
        let refused = "Pipeline refused"
        field.typeText(refused)
        app.buttons["Send"].tap()
        XCTAssertTrue(app.staticTexts[refused].waitForExistence(timeout: 1))
        field.typeText("later")
        Thread.sleep(forTimeInterval: 5)
        XCTAssertEqual(rows(refused), 0, "the refused row is gone")
        XCTAssertTrue(fieldValue().hasPrefix("later"), "what was typed meanwhile stays first: \(fieldValue())")
        XCTAssertTrue(fieldValue().hasSuffix(refused), "the text is back after it: \(fieldValue())")
        shot("send-refused")
    }

    /// A reply with a photo shows at once with the photo, while the upload still runs.
    func testAReplyWithAPhotoShowsItWhileItUploads() throws {
        try control("delays?ack=1000&echo=500&fail=0&upload=4000")
        openThread("mock-long")
        XCTAssertTrue(field.waitForExistence(timeout: 20))
        field.tap()
        app.buttons["Add attachment"].firstMatch.tap()
        app.buttons["Photos"].firstMatch.tap()
        try app.selectSeededPhoto()
        let remove = app.buttons.matching(NSPredicate(format: "label BEGINSWITH 'Remove '")).firstMatch
        XCTAssertTrue(remove.waitForExistence(timeout: 10))
        let name = String(remove.label.dropFirst("Remove ".count))
        let text = "Photo while uploading"
        field.typeText(text)
        app.buttons["Send"].tap()
        XCTAssertTrue(app.staticTexts[text].waitForExistence(timeout: 1.5), "the pending row")
        XCTAssertTrue(app.buttons[name].waitForExistence(timeout: 1.5), "its photo \(name)")
        XCTAssertFalse(remove.exists, "the composer is empty")
        Thread.sleep(forTimeInterval: 1)
        shot("photo-uploading")
        print("PIPELINE-RESULT photo=\(name)")
        // Upload 4 s, then the acknowledgement and the server's row.
        Thread.sleep(forTimeInterval: 5)
        XCTAssertEqual(rows(text), 1)
        shot("photo-sent")
    }

    /// "Working for" counts from the run's start through tool, streamed text and tool, never goes
    /// down, and starts near 0 although the server's clock runs ahead.
    func testWorkingForNeverGoesDown() throws {
        openThread("mock-long")
        XCTAssertTrue(field.waitForExistence(timeout: 20))
        try control("stream?seconds=6&hz=10")
        let label = app.descendants(matching: .any)["thread.workingFold"]
        XCTAssertTrue(label.waitForExistence(timeout: 5))
        var samples: [Int] = []
        let end = Date().addingTimeInterval(11)
        var shots = 0
        while Date() < end {
            if label.exists, let seconds = Self.seconds(label.label) {
                samples.append(seconds)
                if seconds >= 2 * shots && shots < 4 {
                    shot("clock-\(seconds)s")
                    shots += 1
                }
            }
            Thread.sleep(forTimeInterval: 0.25)
        }
        print("PIPELINE-RESULT clock_samples=\(samples)")
        XCTAssertGreaterThan(samples.count, 10)
        XCTAssertLessThanOrEqual(samples.first ?? 99, 3, "server clock offset corrected")
        for (a, b) in zip(samples, samples.dropFirst()) {
            XCTAssertLessThanOrEqual(a, b, "the count went down: \(samples)")
        }
    }

    static func seconds(_ label: String) -> Int? {
        guard let range = label.range(of: "Working for ") else { return nil }
        let rest = label[range.upperBound...]
        var total = 0
        var number = 0
        for character in rest {
            if let digit = character.wholeNumberValue { number = number * 10 + digit }
            else if character == "m" { total += number * 60; number = 0 }
            else if character == "s" { total += number; number = 0 }
        }
        return total
    }

    /// The running subagents show in the thread details sheet with the first projection, though no
    /// agent row is loaded; no capsule floats above the composer for them.
    func testRunningAgentsShowInDetailsWithTheFirstProjection() throws {
        openThread("mock-agents")
        XCTAssertTrue(field.waitForExistence(timeout: 20))
        XCTAssertFalse(app.descendants(matching: .any)["thread.agents"].exists, "no agents capsule")
        app.buttons["thread.moreButton"].tap()
        let heading = app.staticTexts.containing(NSPredicate(format: "label BEGINSWITH %@", "Subagents")).firstMatch
        XCTAssertTrue(heading.waitForExistence(timeout: 10))
        print("PIPELINE-RESULT subagents=\(heading.label)")
        XCTAssertTrue(heading.label.contains("1 running"), heading.label)
        shot("details-running-agents")
    }

    /// Body evaluations while a reply streams and while typing (read from the `bodycount` log).
    func testMeasureFeedChurn() throws {
        openThread("mock-long")
        XCTAssertTrue(field.waitForExistence(timeout: 20))
        Thread.sleep(forTimeInterval: 3)
        mark("idle-end")
        try control("stream?seconds=10&hz=20")
        Thread.sleep(forTimeInterval: 16)
        mark("stream-end")
        field.tap()
        Thread.sleep(forTimeInterval: 2)
        mark("typing-start")
        field.typeText("The quick brown fox jumps over the lazy")
        mark("typing-end")
        Thread.sleep(forTimeInterval: 1.5)
        mark("done")
    }
}
