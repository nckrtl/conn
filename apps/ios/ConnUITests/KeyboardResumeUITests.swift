import XCTest

/// The composer's keyboard across a trip to the Home Screen, against
/// `scripts/queued-messages-fixture.mjs` (`TEST_RUNNER_CONN_PROOF_SERVER`). The app's keyboard
/// probe lists every show and hide notification, so a down-up on return fails the test.
@MainActor
final class KeyboardResumeUITests: XCTestCase {
    private var server = ""
    private let app = XCUIApplication()

    override func setUpWithError() throws {
        continueAfterFailure = false
        guard let server = ProcessInfo.processInfo.environment["CONN_PROOF_SERVER"], !server.isEmpty else {
            throw XCTSkip("Set TEST_RUNNER_CONN_PROOF_SERVER to the queued-messages fixture")
        }
        self.server = server
        _ = try Data(contentsOf: XCTUnwrap(URL(string: server + "/reset")))
        app.launchEnvironment["CONN_TEST_APPEARANCE"] = "dark"
        app.launchEnvironment["CONN_TEST_KEYBOARD_PROBE"] = "1"
        app.launchEnvironment["CONN_TEST_TASK_GATEWAY"] = server
        app.launchEnvironment["CONN_TEST_SAVED_SESSION"] =
            #"{"serverURL":"\#(server)","bearerToken":"fixture","environmentId":"primary"}"#
        app.launchArguments = ["--reset-session"]
    }

    @discardableResult
    private func get(_ path: String) throws -> Data {
        try Data(contentsOf: XCTUnwrap(URL(string: server + "/" + path)))
    }

    private var field: XCUIElement {
        let view = app.textViews.firstMatch
        return view.exists ? view : app.textFields.firstMatch
    }

    private var keyboard: XCUIElement { app.keyboards.firstMatch }

    /// Every keyboard notification since launch, oldest first.
    private func events() -> [String] {
        let probe = app.staticTexts["debug.keyboard"]
        XCTAssertTrue(probe.waitForExistence(timeout: 5), "keyboard probe")
        return probe.label == "none" ? [] : probe.label.components(separatedBy: ",")
    }

    private func openThread(focused: Bool) {
        app.launch()
        let row = app.descendants(matching: .any)["inbox.thread.qidle"]
        XCTAssertTrue(row.waitForExistence(timeout: 30), "inbox row")
        row.tap()
        XCTAssertTrue(app.descendants(matching: .any)["thread.composer"].waitForExistence(timeout: 10), "composer")
        if focused {
            field.tap()
            XCTAssertTrue(keyboard.waitForExistence(timeout: 5), "keyboard up")
        }
        // Let the opening settle, so only the return's notifications follow.
        Thread.sleep(forTimeInterval: 1.5)
    }

    /// Home Screen and back. `dropMs` closes the app's socket while it is away and refuses
    /// reconnects that long, so it returns to a reconnect.
    private func leaveAndReturn(dropMs: Int? = nil) throws {
        XCUIDevice.shared.press(.home)
        XCTAssertTrue(app.wait(for: .runningBackground, timeout: 10) || app.wait(for: .runningBackgroundSuspended, timeout: 10))
        Thread.sleep(forTimeInterval: 1)
        if let dropMs { try get("drop?ms=\(dropMs)") }
        Thread.sleep(forTimeInterval: 1)
        app.activate()
        XCTAssertTrue(app.wait(for: .runningForeground, timeout: 10))
        // Past the reconnect, so its effects show.
        Thread.sleep(forTimeInterval: Double(dropMs ?? 0) / 1000 + 3)
    }

    private func assertKeptFocus(dropMs: Int? = nil, file: StaticString = #filePath, line: UInt = #line) throws {
        openThread(focused: true)
        field.typeText("draft")
        Thread.sleep(forTimeInterval: 0.5)
        let before = events()
        try leaveAndReturn(dropMs: dropMs)
        let after = Array(events().dropFirst(before.count))
        let shot = XCTAttachment(screenshot: app.screenshot())
        shot.name = "returned focused\(dropMs.map { " after a \($0) ms drop" } ?? "")"
        shot.lifetime = .keepAlways
        add(shot)
        XCTAssertFalse(after.contains("hide"), "keyboard went down on return: \(after)", file: file, line: line)
        XCTAssertTrue(keyboard.exists, "keyboard up after return: \(after)", file: file, line: line)
        // The same field still has the caret: typing lands after the draft.
        field.typeText("!")
        XCTAssertEqual(field.value as? String, "draft!", file: file, line: line)
    }

    func testFocusedComposerKeepsKeyboardOnReturn() throws {
        try assertKeptFocus()
    }

    func testFocusedComposerKeepsKeyboardAcrossReconnect() throws {
        try assertKeptFocus(dropMs: 2500)
    }

    func testUnfocusedComposerStaysDownOnReturn() throws {
        openThread(focused: false)
        XCTAssertFalse(keyboard.exists)
        let before = events()
        try leaveAndReturn(dropMs: 2500)
        let after = Array(events().dropFirst(before.count))
        XCTAssertFalse(after.contains("show"), "keyboard came up on return: \(after)")
        XCTAssertFalse(keyboard.exists, "keyboard up after return")
    }
}
