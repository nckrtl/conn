import XCTest

@MainActor
final class ConnSpikeUITests: XCTestCase {
    override func setUpWithError() throws {
        continueAfterFailure = false
    }

    func testPairInboxThreadAndSendMessage() throws {
        let env = ProcessInfo.processInfo.environment
        guard let pairingURL = env["CONN_PAIRING_URL"], !pairingURL.isEmpty else {
            throw XCTSkip("Set CONN_PAIRING_URL to run the live server E2E test")
        }
        let screensDir = env["CONN_SCREENS_DIR"]
        let expectedThreadTitle = env["CONN_THREAD_TITLE"] ?? "Hello from conn-server"
        let expectedReplySnippet = env["CONN_REPLY_SNIPPET"] ?? "Hello, Nick."

        let app = XCUIApplication()
        app.launchArguments = ["--reset-session"]
        app.launch()

        let urlField = app.textFields["pairing.urlField"]
        XCTAssertTrue(urlField.waitForExistence(timeout: 10), "Pairing URL field should appear")
        saveScreenshot(named: "pairing", dir: screensDir)

        urlField.tap()
        urlField.typeText(pairingURL)

        let connectButton = app.buttons["pairing.connectButton"]
        XCTAssertTrue(connectButton.waitForExistence(timeout: 5))
        connectButton.tap()

        let threadRow = app.staticTexts[expectedThreadTitle]
        XCTAssertTrue(threadRow.waitForExistence(timeout: 15), "Seeded thread should appear in inbox")
        saveScreenshot(named: "inbox", dir: screensDir)

        threadRow.tap()

        let replyText = app.staticTexts.containing(NSPredicate(format: "label CONTAINS %@", expectedReplySnippet)).firstMatch
        XCTAssertTrue(replyText.waitForExistence(timeout: 15), "Thread timeline should render existing assistant reply")
        saveScreenshot(named: "thread", dir: screensDir)

        let composer = app.textViews["thread.composerField"].exists
            ? app.textViews["thread.composerField"]
            : app.textFields["thread.composerField"]
        XCTAssertTrue(composer.waitForExistence(timeout: 10), "Composer field should exist")
        composer.tap()
        composer.typeText("ping from iOS")

        let sendButton = app.buttons["thread.sendButton"]
        XCTAssertTrue(sendButton.waitForExistence(timeout: 5))
        sendButton.tap()

        let sentBubble = app.staticTexts["ping from iOS"]
        XCTAssertTrue(sentBubble.waitForExistence(timeout: 15), "Sent message should appear in timeline")
        // Give the layout a moment to settle and scroll before taking the final screenshot.
        RunLoop.current.run(until: Date().addingTimeInterval(1.0))
        saveScreenshot(named: "after-send", dir: screensDir)
    }

    private func saveScreenshot(named name: String, dir: String?) {
        guard let dir, !dir.isEmpty else { return }
        let directory = URL(fileURLWithPath: dir, isDirectory: true)
        try? FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        let data = XCUIScreen.main.screenshot().pngRepresentation
        let fileURL = directory.appendingPathComponent("\(name).png")
        try? data.write(to: fileURL)
    }
}
