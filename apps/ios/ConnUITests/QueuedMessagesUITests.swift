import XCTest

/// Queued messages against `scripts/queued-messages-fixture.mjs`
/// (`PORT=47931 bun apps/ios/scripts/queued-messages-fixture.mjs .` from the repo root). Skipped
/// unless `CONN_PROOF_SERVER` is set (`TEST_RUNNER_CONN_PROOF_SERVER=http://127.0.0.1:47931`).
@MainActor
final class QueuedMessagesUITests: XCTestCase {
    private var server = ""
    private let app = XCUIApplication()

    override func setUpWithError() throws {
        continueAfterFailure = false
        guard let server = ProcessInfo.processInfo.environment["CONN_PROOF_SERVER"], !server.isEmpty else {
            throw XCTSkip("Set TEST_RUNNER_CONN_PROOF_SERVER to the queued-messages fixture")
        }
        self.server = server
        _ = try Data(contentsOf: XCTUnwrap(URL(string: server + "/reset")))
        app.launchEnvironment["CONN_TEST_APPEARANCE"] = ProcessInfo.processInfo.environment["CONN_PROOF_APPEARANCE"] ?? "dark"
        app.launchEnvironment["CONN_TEST_TASK_GATEWAY"] = server
        app.launchEnvironment["CONN_TEST_SAVED_SESSION"] =
            #"{"serverURL":"\#(server)","bearerToken":"fixture","environmentId":"primary"}"#
        app.launchArguments = ["--reset-session"]
    }

    // MARK: - Helpers

    /// The fixture is on this Mac, so a blocking read is quick.
    private func get(_ path: String) throws -> Data {
        try Data(contentsOf: XCTUnwrap(URL(string: server + "/" + path)))
    }

    /// The commands the server received, oldest first.
    private func commands() throws -> [[String: Any]] {
        try XCTUnwrap(JSONSerialization.jsonObject(with: get("commands")) as? [[String: Any]])
    }

    private func waitForCommand(_ type: String, timeout: TimeInterval = 5) throws -> [String: Any] {
        let deadline = Date().addingTimeInterval(timeout)
        repeat {
            if let command = try commands().last(where: { $0["type"] as? String == type }) { return command }
            Thread.sleep(forTimeInterval: 0.2)
        } while Date() < deadline
        XCTFail("server never received \(type)")
        return [:]
    }

    private func shot(_ name: String) {
        let attachment = XCTAttachment(screenshot: app.screenshot())
        attachment.name = name
        attachment.lifetime = .keepAlways
        add(attachment)
    }

    private func openThread(_ id: String) {
        app.launch()
        let row = app.descendants(matching: .any)["inbox.thread.\(id)"]
        XCTAssertTrue(row.waitForExistence(timeout: 30), "inbox row \(id)")
        row.tap()
        XCTAssertTrue(app.descendants(matching: .any)["thread.composer"].waitForExistence(timeout: 10), "composer")
    }

    private func bubble(_ run: String) -> XCUIElement {
        app.descendants(matching: .any)["queued.bubble.\(run)"]
    }

    private var field: XCUIElement {
        let view = app.textViews.firstMatch
        return view.exists ? view : app.textFields.firstMatch
    }

    /// Long-presses a queued bubble and waits for its menu.
    private func openMenu(_ run: String) {
        let target = bubble(run)
        XCTAssertTrue(target.waitForExistence(timeout: 10), "queued bubble \(run)")
        target.press(forDuration: 1.2)
        XCTAssertTrue(app.buttons["Send now"].waitForExistence(timeout: 3), "menu for \(run)")
    }

    /// The queued bubble reads as one element: "Queued message: <text>".
    private func shows(_ run: String, _ text: String) -> Bool {
        bubble(run).exists && bubble(run).label == "Queued message: " + text
    }

    private var editBar: XCUIElement { app.buttons["composer.cancelQueuedEdit"] }

    // MARK: - Tests

    /// The queue sits at the bottom in desktop's style: two rows and "Show all 4 queued", then all four.
    func test1QueuedRowsAndToggle() throws {
        openThread("qbusy")
        XCTAssertTrue(bubble("run:qbusy:q0").waitForExistence(timeout: 10), "first queued row")
        XCTAssertTrue(bubble("run:qbusy:q1").exists, "second queued row")
        XCTAssertFalse(bubble("run:qbusy:q2").exists, "third row waits behind the toggle")
        let toggle = app.buttons["queued.toggle"]
        XCTAssertTrue(toggle.exists, "toggle")
        XCTAssertEqual(toggle.label, "Show all 4 queued")
        XCTAssertTrue(shows("run:qbusy:q0", "Check dark mode on Polar."), "queued text: \(bubble("run:qbusy:q0").label)")
        XCTAssertGreaterThan(bubble("run:qbusy:q0").frame.minY, app.staticTexts["Step 3: keep going."].frame.maxY,
                             "the queue sits below the running turn")
        Thread.sleep(forTimeInterval: 0.6)
        shot("queue-collapsed")

        toggle.tap()
        XCTAssertTrue(bubble("run:qbusy:q3").waitForExistence(timeout: 3), "the whole queue shows")
        XCTAssertEqual(app.buttons["queued.toggle"].label, "Show fewer")
        let order = (0..<4).map { bubble("run:qbusy:q\($0)").frame.minY }
        XCTAssertEqual(order, order.sorted(), "oldest first, as desktop")
        Thread.sleep(forTimeInterval: 0.6)
        shot("queue-expanded")
    }

    /// A long press shows Send now, Edit and Remove under the sent time, then Copy and Select text.
    /// It doesn't reveal the copy button; a tap still does.
    func test2LongPressMenu() throws {
        openThread("qbusy")
        openMenu("run:qbusy:q0")
        XCTAssertTrue(app.buttons["Edit"].exists, "Edit")
        XCTAssertTrue(app.buttons["Remove"].exists, "Remove")
        XCTAssertTrue(app.buttons["Copy"].exists, "Copy")
        XCTAssertTrue(app.buttons["Select text"].exists, "Select text")
        let header = app.staticTexts.matching(NSPredicate(format: "label BEGINSWITH 'Today, '")).firstMatch
        XCTAssertTrue(header.exists, "sent-time header")
        Thread.sleep(forTimeInterval: 0.4)
        shot("queue-menu")
        // Dismiss the menu without choosing.
        app.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.12)).tap()
        XCTAssertTrue(app.buttons["Send now"].waitForNonExistence(timeout: 3), "menu closed")
        let row = app.descendants(matching: .any)["queued.row.run:qbusy:q0"]
        XCTAssertFalse(row.buttons["Copy message"].exists, "the long press didn't reveal the copy button")
        bubble("run:qbusy:q0").tap()
        XCTAssertTrue(row.buttons["Copy message"].waitForExistence(timeout: 2), "a tap reveals the copy button")
        XCTAssertTrue(try commands().isEmpty, "nothing was sent")
    }

    /// Edit loads the text into the composer in edit mode; Save sends `queued-run.edit` and the row updates.
    func test3Edit() throws {
        openThread("qbusy")
        let draft = "Draft I was writing"
        field.tap()
        field.typeText(draft)
        openMenu("run:qbusy:q0")
        app.buttons["Edit"].tap()
        let bar = editBar
        XCTAssertTrue(bar.waitForExistence(timeout: 3), "edit mode with a visible Cancel")
        XCTAssertTrue(app.staticTexts["Editing queued message"].exists)
        XCTAssertEqual(field.value as? String, "Check dark mode on Polar.")
        XCTAssertTrue(app.staticTexts["Editing in the composer"].exists, "the row shows it is being edited")
        shot("edit-mode")

        // Cancel brings the earlier draft back.
        bar.tap()
        XCTAssertTrue(bar.waitForNonExistence(timeout: 3), "edit mode closed")
        XCTAssertEqual(field.value as? String, draft)

        openMenu("run:qbusy:q0")
        app.buttons["Edit"].tap()
        XCTAssertTrue(bar.waitForExistence(timeout: 3), "edit mode again")
        field.typeText(XCUIKeyboardKey.delete.rawValue)
        field.typeText(" and light mode too.")
        app.buttons["Send"].tap()
        let edit = try waitForCommand("queued-run.edit")
        XCTAssertEqual(edit["runId"] as? String, "run:qbusy:q0")
        XCTAssertEqual(edit["text"] as? String, "Check dark mode on Polar and light mode too.")
        XCTAssertNil(edit["attachments"], "unchanged files stay off the command")
        let updated = NSPredicate { _, _ in self.shows("run:qbusy:q0", "Check dark mode on Polar and light mode too.") }
        wait(for: [XCTNSPredicateExpectation(predicate: updated, object: nil)], timeout: 3)
        XCTAssertFalse(bar.exists, "edit mode closed after Save")
        XCTAssertEqual(field.value as? String, draft, "the earlier draft is back")
        Thread.sleep(forTimeInterval: 0.6)
        shot("edit-saved")
    }

    /// A refused edit shows the old text again, reopens the edit with what was typed and says why.
    func test4EditFailureRollsBack() throws {
        openThread("qbusy")
        openMenu("run:qbusy:q1")
        app.buttons["Edit"].tap()
        XCTAssertTrue(editBar.waitForExistence(timeout: 3))
        field.typeText(" [fail]")
        app.buttons["Send"].tap()
        _ = try waitForCommand("queued-run.edit")
        let error = app.staticTexts.matching(NSPredicate(format: "label CONTAINS 'Could not update queued message'")).firstMatch
        XCTAssertTrue(error.waitForExistence(timeout: 5), "error under the composer")
        XCTAssertTrue(editBar.exists, "the edit reopens")
        XCTAssertTrue((field.value as? String)?.hasSuffix("[fail]") == true, "with what was typed")
        XCTAssertTrue(shows("run:qbusy:q1", "Then run the simulator UI test and attach the screenshots."), "old text back")
        shot("edit-refused")
    }

    /// Remove hides the row and sends `queued-run.cancel`.
    func test5Remove() throws {
        openThread("qbusy")
        openMenu("run:qbusy:q1")
        app.buttons["Remove"].tap()
        XCTAssertTrue(bubble("run:qbusy:q1").waitForNonExistence(timeout: 3), "row gone")
        let cancel = try waitForCommand("queued-run.cancel")
        XCTAssertEqual(cancel["runId"] as? String, "run:qbusy:q1")
        XCTAssertEqual(cancel["threadId"] as? String, "qbusy")
        // Three left: no toggle.
        XCTAssertTrue(bubble("run:qbusy:q2").waitForExistence(timeout: 3), "the third row moves up")
        XCTAssertFalse(app.buttons["queued.toggle"].exists, "three rows need no toggle")
        Thread.sleep(forTimeInterval: 0.6)
        shot("removed")
    }

    /// Send now while the agent works steers the running turn.
    func test6SendNowWhileRunningPromotes() throws {
        openThread("qbusy")
        openMenu("run:qbusy:q0")
        app.buttons["Send now"].tap()
        let promote = try waitForCommand("queued-message.promote-to-steer")
        XCTAssertEqual(promote["queuedRunId"] as? String, "run:qbusy:q0")
        XCTAssertEqual(promote["targetRunId"] as? String, "run:qbusy:2")
        XCTAssertTrue(bubble("run:qbusy:q0").waitForNonExistence(timeout: 5), "row leaves the queue")
        XCTAssertTrue(app.staticTexts.containing(NSPredicate(format: "label == 'Check dark mode on Polar.'")).firstMatch
            .waitForExistence(timeout: 3), "it is in the turn")
        Thread.sleep(forTimeInterval: 0.6)
        shot("sent-now-running")
    }

    /// Send now on a stopped thread starts the queued run.
    func test7SendNowWhileIdleStarts() throws {
        openThread("qidle")
        Thread.sleep(forTimeInterval: 0.6)
        shot("idle-queue")
        openMenu("run:qidle:q0")
        app.buttons["Send now"].tap()
        let start = try waitForCommand("queued-run.start")
        XCTAssertEqual(start["runId"] as? String, "run:qidle:q0")
        XCTAssertTrue(bubble("run:qidle:q0").waitForNonExistence(timeout: 5), "row leaves the queue")
        Thread.sleep(forTimeInterval: 0.6)
        shot("sent-now-idle")
    }

    /// With the keyboard up in a running thread, a long press opens the menu and the app stays
    /// responsive (the feed's jump circle and its inset used to flip each other without end).
    func test8MenuWithKeyboardUp() throws {
        openThread("qbusy")
        field.tap()
        field.typeText("Draft")
        let message = app.staticTexts.containing(NSPredicate(format: "label BEGINSWITH 'Step 3'")).firstMatch
        // Pinned to the end above the keyboard, the message sits just off screen: a short drag down
        // in the feed (away from the keyboard) brings it into view. Off-screen cells aren't in the tree.
        if !message.exists {
            app.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.2))
                .press(forDuration: 0.05, thenDragTo: app.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.4)),
                       withVelocity: .slow, thenHoldForDuration: 0.3)
        }
        XCTAssertTrue(message.waitForExistence(timeout: 5), "user message")
        XCTAssertTrue(app.keyboards.firstMatch.exists, "the keyboard is still up")
        message.press(forDuration: 1.2)
        XCTAssertTrue(app.buttons["Copy"].waitForExistence(timeout: 5), "plain message menu")
        app.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.12)).tap()
        XCTAssertTrue(app.buttons["Copy"].waitForNonExistence(timeout: 3))
        // Back to the end, where the queue sits above the composer.
        let jump = app.buttons["thread.scrollToEnd"]
        if jump.exists { jump.tap(); Thread.sleep(forTimeInterval: 0.8) }
        openMenu("run:qbusy:q0")
        shot("menu-keyboard-up")
    }
}
