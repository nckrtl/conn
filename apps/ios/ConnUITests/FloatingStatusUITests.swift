import XCTest

/// Status messages above the composer ("Syncing", "Not connected") float: they come and go without
/// moving the thread. Runs against `scripts/feed-fixture.mjs`, skipped unless `CONN_FEED_SERVER` is
/// set (`TEST_RUNNER_CONN_FEED_SERVER=http://127.0.0.1:<port>`).
@MainActor
final class FloatingStatusUITests: XCTestCase {
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

    override func tearDown() async throws {
        _ = try? get("reset")
    }

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

    private func openThread(_ id: String) {
        app.launch()
        let row = app.descendants(matching: .any)["inbox.thread.\(id)"]
        XCTAssertTrue(row.waitForExistence(timeout: 30), "inbox row \(id)")
        row.tap()
    }

    /// The feed thread's last row: the second point of reply 30.
    private var lastRow: XCUIElement {
        app.staticTexts.containing(NSPredicate(format: "label CONTAINS %@", "Point 2 of reply 30.")).firstMatch
    }

    private var syncing: XCUIElement { app.descendants(matching: .any)["thread.syncing"] }
    private var offline: XCUIElement {
        app.descendants(matching: .any).matching(NSPredicate(format: "label == %@", "Not connected")).firstMatch
    }

    /// The last row's frame once the feed has settled.
    private func settledFrame() -> CGRect {
        wait(1.0)
        return lastRow.frame
    }

    private func assertSameFrame(_ before: CGRect, _ after: CGRect, _ message: String) {
        print("FLOATPROOF \(message) before=\(before) after=\(after) dy=\(after.minY - before.minY)")
        XCTAssertEqual(after.minY, before.minY, accuracy: 0.5, "the last row moved: \(message)")
        XCTAssertEqual(after.maxY, before.maxY, accuracy: 0.5, "the last row moved: \(message)")
    }

    /// "Syncing" shows while the server has not confirmed the thread; when it goes, the thread stays.
    func testSyncingEndingLeavesTheThreadInPlace() throws {
        try get("hold")
        openThread("feed")
        XCTAssertTrue(lastRow.waitForExistence(timeout: 15), "last row")
        XCTAssertTrue(syncing.waitForExistence(timeout: 10), "Syncing shows")
        let during = settledFrame()
        shot("floating-syncing")
        try get("sync")
        XCTAssertTrue(syncing.waitForNonExistence(timeout: 10), "Syncing goes")
        let after = settledFrame()
        shot("floating-synced")
        assertSameFrame(during, after, "syncing ended")
    }

    /// Going offline shows "Not connected" over the end of the feed, and coming back removes it,
    /// with the thread in place throughout.
    func testGoingOfflineAndBackLeavesTheThreadInPlace() throws {
        openThread("feed")
        XCTAssertTrue(lastRow.waitForExistence(timeout: 15), "last row")
        XCTAssertTrue(syncing.waitForNonExistence(timeout: 10), "synced")
        let online = settledFrame()
        try get("drop?ms=25000")
        // The pill waits for the 10 s grace window.
        XCTAssertTrue(offline.waitForExistence(timeout: 30), "Not connected shows")
        let away = settledFrame()
        shot("floating-offline")
        assertSameFrame(online, away, "went offline")
        XCTAssertTrue(offline.waitForNonExistence(timeout: 60), "Not connected goes")
        XCTAssertTrue(syncing.waitForNonExistence(timeout: 15), "synced again")
        let back = settledFrame()
        shot("floating-back-online")
        assertSameFrame(online, back, "came back")
    }

    /// Offline, asking for older messages than the cache holds shows the history notice in the same
    /// floating spot, in place of "Not connected", 12 pt above the composer.
    func testHistoryNoticeFloatsAboveTheComposer() throws {
        openThread("feed")
        XCTAssertTrue(lastRow.waitForExistence(timeout: 15), "last row")
        XCTAssertTrue(syncing.waitForNonExistence(timeout: 10), "synced")
        // Older history exists from now on; opening the thread asked for none.
        try get("older")
        wait(1.0)
        // Scrolled up, the jump circle floats in the same row.
        for _ in 0..<2 { app.swipeDown(velocity: .slow) }
        XCTAssertTrue(app.buttons["thread.scrollToEnd"].waitForExistence(timeout: 5), "jump circle")
        wait(0.6)
        shot("floating-jump")
        try get("drop?ms=60000")
        XCTAssertTrue(offline.waitForExistence(timeout: 30), "Not connected shows")
        let earlier = app.buttons["Earlier messages"]
        let notice = app.descendants(matching: .any)["thread.historyNotice"]
        // Reaching the top asks for older messages by itself; the button asks again.
        for _ in 0..<30 where !(earlier.exists && earlier.isHittable) && !notice.exists {
            app.swipeDown(velocity: .fast)
        }
        if !notice.exists { earlier.tap() }
        XCTAssertTrue(notice.waitForExistence(timeout: 10), "history notice")
        XCTAssertFalse(offline.exists, "one status at a time")
        wait(0.6)
        shot("floating-history")
        let field = app.textViews.firstMatch.exists ? app.textViews.firstMatch : app.textFields.firstMatch
        print("FLOATPROOF history notice=\(notice.frame) field=\(field.frame)")
        XCTAssertLessThan(notice.frame.maxY, field.frame.minY, "the notice floats above the composer")
    }
}
