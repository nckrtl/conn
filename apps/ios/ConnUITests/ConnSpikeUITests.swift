import XCTest

@MainActor
final class ConnSpikeUITests: XCTestCase {
    override func setUpWithError() throws {
        continueAfterFailure = false
    }

    func testLayoutPortEndToEndFlow() throws {
        let env = ProcessInfo.processInfo.environment
        guard let pairingURL = env["CONN_PAIRING_URL"], !pairingURL.isEmpty else {
            throw XCTSkip("Set CONN_PAIRING_URL to run the live server E2E test")
        }
        let screensDir = env["CONN_SCREENS_DIR"]
        let themeSuffix = env["CONN_SCREEN_SUFFIX"] ?? ""
        let expectedThreadTitle = env["CONN_THREAD_TITLE"] ?? "Inspect main.rs and greeting"
        let expectedReplySnippet = env["CONN_REPLY_SNIPPET"] ?? "main.rs"
        let runMutations = env["CONN_SKIP_MUTATIONS"] != "1"
        // CONN_APPEARANCE=dark|light captures the dark/light comparison pairs.
        switch env["CONN_APPEARANCE"] {
        case "dark": XCUIDevice.shared.appearance = .dark
        case "light": XCUIDevice.shared.appearance = .light
        default: break
        }

        let app = XCUIApplication()
        app.launchArguments = ["--reset-session"]
        app.launch()

        // 1. Pair
        let urlField = app.textFields["pairing.urlField"]
        XCTAssertTrue(urlField.waitForExistence(timeout: 10), "Pairing URL field should appear")
        urlField.tap()
        urlField.typeText(pairingURL)

        let connectButton = app.buttons["pairing.connectButton"]
        XCTAssertTrue(connectButton.waitForExistence(timeout: 5))
        connectButton.tap()

        // 2. Home (Threads)
        let threadRow = app.staticTexts[expectedThreadTitle].firstMatch
        XCTAssertTrue(threadRow.waitForExistence(timeout: 15), "Seeded thread should appear in home list")
        RunLoop.current.run(until: Date().addingTimeInterval(0.6))
        saveScreenshot(named: "home\(themeSuffix)", dir: screensDir)

        // 2b. Search mode
        let searchButton = app.buttons["workspace.searchButton"].firstMatch
        if searchButton.waitForExistence(timeout: 5) {
            searchButton.tap()
            RunLoop.current.run(until: Date().addingTimeInterval(0.5))
            saveScreenshot(named: "search\(themeSuffix)", dir: screensDir)
            let cancelSearch = app.buttons["workspace.cancelSearchButton"].firstMatch
            if cancelSearch.waitForExistence(timeout: 5) {
                cancelSearch.tap()
                RunLoop.current.run(until: Date().addingTimeInterval(0.4))
            }
        }

        // 2c. Tasks tab: Orbit's tasks (or why they cannot be read), then the lane menu.
        let tasksTab = app.buttons["workspace.tab.tasks"].firstMatch
        if tasksTab.waitForExistence(timeout: 5) {
            tasksTab.tap()
            let answered = NSPredicate(format: "identifier BEGINSWITH 'tasks.row.' OR identifier IN {'tasks.empty', 'tasks.error'}")
            XCTAssertTrue(
                app.descendants(matching: .any).matching(answered).firstMatch.waitForExistence(timeout: 20),
                "The Tasks tab should show tasks, an empty lane or why it cannot read them"
            )
            RunLoop.current.run(until: Date().addingTimeInterval(0.5))
            saveScreenshot(named: "tasks\(themeSuffix)", dir: screensDir)
            let laneMenu = app.buttons["tasks.laneMenu"].firstMatch
            if laneMenu.waitForExistence(timeout: 5) {
                laneMenu.tap()
                RunLoop.current.run(until: Date().addingTimeInterval(0.8))
                saveScreenshot(named: "tasks-lanes\(themeSuffix)", dir: screensDir)
                // Close the menu without picking a lane.
                app.coordinate(withNormalizedOffset: CGVector(dx: 0.1, dy: 0.55)).tap()
                RunLoop.current.run(until: Date().addingTimeInterval(0.5))
            }
        }

        // 2d. Pull requests tab
        let prsTab = app.buttons["workspace.tab.pullRequests"].firstMatch
        if prsTab.waitForExistence(timeout: 5) {
            prsTab.tap()
            RunLoop.current.run(until: Date().addingTimeInterval(0.5))
            saveScreenshot(named: "prs\(themeSuffix)", dir: screensDir)
        }

        // Return to Threads tab
        let threadsTab = app.buttons["workspace.tab.threads"].firstMatch
        if threadsTab.waitForExistence(timeout: 5) {
            threadsTab.tap()
            RunLoop.current.run(until: Date().addingTimeInterval(0.4))
        }

        // 2e. Settings sheet
        let settingsButton = app.buttons["workspace.settingsButton"].firstMatch
        if settingsButton.waitForExistence(timeout: 5) {
            settingsButton.tap()
            RunLoop.current.run(until: Date().addingTimeInterval(0.6))
            saveScreenshot(named: "settings\(themeSuffix)", dir: screensDir)
            let closeSettings = app.buttons["settings.closeButton"].firstMatch
            if closeSettings.waitForExistence(timeout: 5) {
                closeSettings.tap()
                RunLoop.current.run(until: Date().addingTimeInterval(0.4))
            }
        }

        // 3. Open thread
        XCTAssertTrue(threadRow.waitForExistence(timeout: 10))
        threadRow.tap()

        let replyText = app.staticTexts.containing(NSPredicate(format: "label CONTAINS[c] %@", expectedReplySnippet)).firstMatch
        XCTAssertTrue(replyText.waitForExistence(timeout: 15), "Thread timeline should render existing assistant reply")
        RunLoop.current.run(until: Date().addingTimeInterval(0.6))
        saveScreenshot(named: "thread\(themeSuffix)", dir: screensDir)

        // 3b. Thread ellipsis menu
        let moreButton = app.buttons["thread.moreButton"].firstMatch
        if moreButton.waitForExistence(timeout: 5) {
            moreButton.tap()
            RunLoop.current.run(until: Date().addingTimeInterval(0.5))
            saveScreenshot(named: "thread-menu\(themeSuffix)", dir: screensDir)
            // Dismiss menu by tapping center of screen
            app.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.5)).tap()
            RunLoop.current.run(until: Date().addingTimeInterval(0.4))
        }

        if runMutations {
            // 4. Send message
            let composer = app.textViews["Ask anything"].exists
                ? app.textViews["Ask anything"]
                : app.textFields["Ask anything"].firstMatch
            XCTAssertTrue(composer.waitForExistence(timeout: 10), "Composer field should exist")
            composer.tap()
            composer.typeText("Reply with just OK.")

            let sendButton = app.buttons["Send"].firstMatch
            XCTAssertTrue(sendButton.waitForExistence(timeout: 5))
            sendButton.tap()

            let sentBubble = app.staticTexts["Reply with just OK."].firstMatch
            XCTAssertTrue(sentBubble.waitForExistence(timeout: 15), "Sent message should appear in timeline")
            RunLoop.current.run(until: Date().addingTimeInterval(0.8))

            // 5. Back to home & settle via swipe
            app.navigationBars.buttons.element(boundBy: 0).tap()
            XCTAssertTrue(threadRow.waitForExistence(timeout: 10), "Should return to home")
            threadRow.swipeLeft()

            let settleButton = app.buttons["Settle"].firstMatch
            if settleButton.waitForExistence(timeout: 5) {
                settleButton.tap()
            }
            let settledHeader = app.buttons["inbox.settledHeader"].firstMatch
            if !settledHeader.waitForExistence(timeout: 4) {
                app.swipeUp()
            }
            XCTAssertTrue(settledHeader.waitForExistence(timeout: 10), "Settled shelf should appear after settling")

            // 6. New thread draft opened directly by "+"
            let newThreadButton = app.buttons["inbox.newThreadButton"].firstMatch
            XCTAssertTrue(newThreadButton.waitForExistence(timeout: 5))
            newThreadButton.tap()
            RunLoop.current.run(until: Date().addingTimeInterval(0.6))
            saveScreenshot(named: "new-chat\(themeSuffix)", dir: screensDir)

            let promptField = app.textViews["Ask anything"].exists
                ? app.textViews["Ask anything"]
                : app.textFields["Ask anything"].firstMatch
            XCTAssertTrue(promptField.waitForExistence(timeout: 10), "New thread composer should appear")
            promptField.tap()
            promptField.typeText("Say hi from ios layout port")

            let draftSendButton = app.buttons["Send"].firstMatch
            XCTAssertTrue(draftSendButton.waitForExistence(timeout: 5))
            draftSendButton.tap()

            let launchedBubble = app.staticTexts["Say hi from ios layout port"].firstMatch
            XCTAssertTrue(launchedBubble.waitForExistence(timeout: 20), "Launched thread should open with initial message")
        } else {
            // Screenshot-only pass (e.g. light mode)
            app.navigationBars.buttons.element(boundBy: 0).tap()
            let newThreadButton = app.buttons["inbox.newThreadButton"].firstMatch
            if newThreadButton.waitForExistence(timeout: 5) {
                newThreadButton.tap()
                RunLoop.current.run(until: Date().addingTimeInterval(0.5))
                saveScreenshot(named: "new-chat\(themeSuffix)", dir: screensDir)
            }
        }
    }

    /// The question panel on a thread whose (fake Grok) run waits for three answers. With
    /// CONN_QUESTION_ANSWER=1 it answers every step, from the options and the composer.
    func testQuestionPanelFlow() throws {
        let env = ProcessInfo.processInfo.environment
        guard let pairingURL = env["CONN_PAIRING_URL"], !pairingURL.isEmpty,
              let title = env["CONN_QUESTION_THREAD_TITLE"], !title.isEmpty
        else {
            throw XCTSkip("Set CONN_PAIRING_URL and CONN_QUESTION_THREAD_TITLE")
        }
        let screensDir = env["CONN_SCREENS_DIR"]
        let suffix = env["CONN_SCREEN_SUFFIX"] ?? ""
        switch env["CONN_APPEARANCE"] {
        case "dark": XCUIDevice.shared.appearance = .dark
        case "light": XCUIDevice.shared.appearance = .light
        default: break
        }

        let app = XCUIApplication()
        app.launchArguments = ["--reset-session"]
        app.launch()
        let urlField = app.textFields["pairing.urlField"]
        XCTAssertTrue(urlField.waitForExistence(timeout: 10), "Pairing URL field should appear")
        urlField.tap()
        urlField.typeText(pairingURL)
        app.buttons["pairing.connectButton"].tap()

        let threadRow = app.staticTexts[title].firstMatch
        XCTAssertTrue(threadRow.waitForExistence(timeout: 15), "The question thread should be listed")
        threadRow.tap()

        let panel = app.descendants(matching: .any)
            .matching(NSPredicate(format: "identifier BEGINSWITH 'thread.question.'")).firstMatch
        XCTAssertTrue(panel.waitForExistence(timeout: 15), "The question panel should open above the composer")
        RunLoop.current.run(until: Date().addingTimeInterval(0.8))
        saveScreenshot(named: "question-1\(suffix)", dir: screensDir)
        guard env["CONN_QUESTION_ANSWER"] == "1" else { return }

        // Step 1: a single-choice pick moves on by itself.
        app.buttons["question.option.Postgres"].firstMatch.tap()
        let clippy = app.buttons["question.option.clippy"].firstMatch
        XCTAssertTrue(clippy.waitForExistence(timeout: 5), "The pick should move to step 2")
        clippy.tap()
        app.buttons["question.option.tests"].firstMatch.tap()
        RunLoop.current.run(until: Date().addingTimeInterval(0.4))
        saveScreenshot(named: "question-2\(suffix)", dir: screensDir)
        app.buttons["question.next"].firstMatch.tap()

        // Step 3: the composer's text is the answer; it shows as "Your answer" while typed.
        XCTAssertTrue(
            app.staticTexts["What should the branch be called?"].firstMatch.waitForExistence(timeout: 5),
            "Next should move to step 3"
        )
        let composer = app.textViews.firstMatch.exists ? app.textViews.firstMatch : app.textFields.firstMatch
        composer.tap()
        composer.typeText("conn/cache-store")
        XCTAssertTrue(app.staticTexts["Your answer"].firstMatch.waitForExistence(timeout: 5), "Typed text shows as the answer")
        RunLoop.current.run(until: Date().addingTimeInterval(0.4))
        saveScreenshot(named: "question-3\(suffix)", dir: screensDir)
        app.buttons["Send"].firstMatch.tap()

        // The answers reach the agent: the panel goes and the agent's reply names them.
        let reply = app.staticTexts.containing(NSPredicate(format: "label CONTAINS %@", "conn/cache-store")).firstMatch
        XCTAssertTrue(reply.waitForExistence(timeout: 20), "The agent should reply with the answers")
        XCTAssertFalse(panel.exists, "The panel should close once answered")
        RunLoop.current.run(until: Date().addingTimeInterval(0.6))
        saveScreenshot(named: "question-answered\(suffix)", dir: screensDir)
    }

    func testCaptureExpoReferenceScreens() throws {
        let env = ProcessInfo.processInfo.environment
        guard env["CONN_CAPTURE_EXPO"] == "1" else {
            throw XCTSkip("Set CONN_CAPTURE_EXPO=1 to capture Expo reference screenshots")
        }
        let screensDir = env["CONN_SCREENS_DIR"]
        let suffix = env["CONN_SCREEN_SUFFIX"] ?? ""
        let expectedThreadTitle = env["CONN_THREAD_TITLE"] ?? "Explore conn-gpui layout"

        let springboard = XCUIApplication(bundleIdentifier: "com.apple.springboard")
        let openButton = springboard.buttons["Open"].firstMatch
        if openButton.waitForExistence(timeout: 3) {
            openButton.tap()
        }

        let expo = XCUIApplication(bundleIdentifier: "com.t3tools.t3code.dev")
        expo.activate()
        RunLoop.current.run(until: Date().addingTimeInterval(2.0))

        // Dismiss any SpringBoard alert if still present
        if openButton.waitForExistence(timeout: 2) {
            openButton.tap()
            RunLoop.current.run(until: Date().addingTimeInterval(2.0))
        }

        // Wait for Home threads list (React Native combines row text into a button's accessibilityLabel)
        let threadRow = expo.descendants(matching: .any)
            .matching(NSPredicate(format: "label CONTAINS[c] %@", expectedThreadTitle))
            .firstMatch
        XCTAssertTrue(threadRow.waitForExistence(timeout: 25), "Expo Home should show seeded thread '\(expectedThreadTitle)'")
        RunLoop.current.run(until: Date().addingTimeInterval(0.8))
        saveScreenshot(named: "home\(suffix)", dir: screensDir)

        // Search mode
        let searchBtn = expo.buttons["Search"].firstMatch
        if searchBtn.waitForExistence(timeout: 5) {
            searchBtn.tap()
            RunLoop.current.run(until: Date().addingTimeInterval(0.8))
            // Dismiss iOS swipe-typing keyboard tip if shown
            let continueBtn = expo.buttons["Continue"].firstMatch
            if continueBtn.waitForExistence(timeout: 2) {
                continueBtn.tap()
                RunLoop.current.run(until: Date().addingTimeInterval(0.5))
            }
            saveScreenshot(named: "search\(suffix)", dir: screensDir)
            // Dismiss search bar via Close / Cancel button
            let closeSearch = expo.buttons["Close"].firstMatch.exists
                ? expo.buttons["Close"].firstMatch
                : expo.buttons["Cancel"].firstMatch
            if closeSearch.waitForExistence(timeout: 3) {
                closeSearch.tap()
                RunLoop.current.run(until: Date().addingTimeInterval(0.6))
            } else {
                // Tap the trailing X button in the search bar
                expo.coordinate(withNormalizedOffset: CGVector(dx: 0.91, dy: 0.59)).tap()
                RunLoop.current.run(until: Date().addingTimeInterval(0.6))
            }
        }

        // Tasks tab
        let tasksBtn = expo.buttons["Tasks"].firstMatch
        if tasksBtn.waitForExistence(timeout: 5) {
            tasksBtn.tap()
            RunLoop.current.run(until: Date().addingTimeInterval(0.8))
            saveScreenshot(named: "tasks\(suffix)", dir: screensDir)
        }

        // Pull requests tab
        let prsBtn = expo.buttons["Pull requests"].firstMatch
        if prsBtn.waitForExistence(timeout: 5) {
            prsBtn.tap()
            RunLoop.current.run(until: Date().addingTimeInterval(0.8))
            saveScreenshot(named: "prs\(suffix)", dir: screensDir)
        }

        // Back to Threads
        let threadsBtn = expo.buttons["Threads"].firstMatch
        if threadsBtn.waitForExistence(timeout: 5) {
            threadsBtn.tap()
            RunLoop.current.run(until: Date().addingTimeInterval(0.6))
        }

        // Settings
        let settingsBtn = expo.buttons["Open settings"].firstMatch
        if settingsBtn.waitForExistence(timeout: 5) {
            settingsBtn.tap()
            RunLoop.current.run(until: Date().addingTimeInterval(0.8))
            saveScreenshot(named: "settings\(suffix)", dir: screensDir)
            // Swipe down to dismiss pageSheet
            expo.swipeDown()
            RunLoop.current.run(until: Date().addingTimeInterval(0.6))
        }

        // Thread
        if threadRow.waitForExistence(timeout: 10) {
            threadRow.tap()
            RunLoop.current.run(until: Date().addingTimeInterval(1.2))
            saveScreenshot(named: "thread\(suffix)", dir: screensDir)

            let moreBtn = expo.buttons["More actions"].firstMatch
            if moreBtn.waitForExistence(timeout: 5) {
                moreBtn.tap()
                RunLoop.current.run(until: Date().addingTimeInterval(0.6))
                saveScreenshot(named: "thread-menu\(suffix)", dir: screensDir)
                expo.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.5)).tap()
                RunLoop.current.run(until: Date().addingTimeInterval(0.5))
            }

            // Back to Home
            let backBtn = expo.navigationBars.buttons.element(boundBy: 0)
            if backBtn.exists {
                backBtn.tap()
                RunLoop.current.run(until: Date().addingTimeInterval(0.6))
            }
        }

        // New chat
        let newChatBtn = expo.buttons["New chat"].firstMatch
        if newChatBtn.waitForExistence(timeout: 5) {
            newChatBtn.tap()
            RunLoop.current.run(until: Date().addingTimeInterval(0.8))
            saveScreenshot(named: "new-chat\(suffix)", dir: screensDir)
        }
    }

    /// Fidelity capture: walks the same screens in this app (`CONN_FIDELITY_APP=swift`) or the Expo
    /// app (`expo`). At each screen it asks the host for a `simctl io screenshot` through
    /// `CONN_FIDELITY_DIR/req` and waits for the name in `CONN_FIDELITY_DIR/ack`.
    func testFidelityCapture() throws {
        let env = ProcessInfo.processInfo.environment
        guard let which = env["CONN_FIDELITY_APP"], let dir = env["CONN_FIDELITY_DIR"],
              let pairingURL = env["CONN_PAIRING_URL"]
        else { throw XCTSkip("Set CONN_FIDELITY_APP, CONN_FIDELITY_DIR and CONN_PAIRING_URL") }
        let expo = which == "expo"
        switch env["CONN_APPEARANCE"] {
        case "dark": XCUIDevice.shared.appearance = .dark
        case "light": XCUIDevice.shared.appearance = .light
        default: break
        }
        let springboard = XCUIApplication(bundleIdentifier: "com.apple.springboard")
        func settle(_ seconds: Double = 1.0) { RunLoop.current.run(until: Date().addingTimeInterval(seconds)) }
        func capture(_ name: String) {
            settle(1.2)
            let req = URL(fileURLWithPath: dir).appendingPathComponent("req")
            let ack = URL(fileURLWithPath: dir).appendingPathComponent("ack")
            try? name.write(to: req, atomically: true, encoding: .utf8)
            let deadline = Date().addingTimeInterval(20)
            while Date() < deadline {
                if (try? String(contentsOf: ack, encoding: .utf8)) == name { return }
                settle(0.2)
            }
            XCTFail("host did not capture \(name)")
        }
        func first(_ app: XCUIApplication, _ keys: [String], timeout: Double = 6) -> XCUIElement? {
            let any = app.descendants(matching: .any)
            let deadline = Date().addingTimeInterval(timeout)
            repeat {
                for key in keys {
                    let byId = any.matching(identifier: key).firstMatch
                    if byId.exists && byId.isHittable { return byId }
                    let byLabel = app.buttons[key].firstMatch
                    if byLabel.exists && byLabel.isHittable { return byLabel }
                }
                settle(0.3)
            } while Date() < deadline
            return nil
        }
        func tap(_ app: XCUIApplication, _ keys: [String]) -> Bool {
            guard let element = first(app, keys) else { return false }
            element.tap()
            return true
        }
        func row(_ app: XCUIApplication, _ title: String) -> XCUIElement {
            app.descendants(matching: .any)
                .matching(NSPredicate(format: "label == %@ OR label BEGINSWITH %@", title, title)).firstMatch
        }
        func back(_ app: XCUIApplication) {
            if !tap(app, ["Back", "thread.backButton"]) {
                let nav = app.navigationBars.buttons.element(boundBy: 0)
                if nav.exists { nav.tap() } else { app.swipeRight() }
            }
            settle(0.8)
        }

        let app: XCUIApplication
        if expo {
            app = XCUIApplication(bundleIdentifier: env["CONN_EXPO_BUNDLE"] ?? "com.nckrtl.conn")
            app.activate()
            settle(3)
            let encoded = pairingURL.addingPercentEncoding(withAllowedCharacters: .alphanumerics) ?? pairingURL
            app.open(URL(string: "t3code://connections/new?pairingUrl=\(encoded)")!)
            if springboard.buttons["Open"].waitForExistence(timeout: 3) { springboard.buttons["Open"].tap() }
            settle(2)
            XCTAssertTrue(tap(app, ["Connect"]), "Expo pairing form should offer Connect")
            settle(4)
        } else {
            app = XCUIApplication()
            app.launchArguments = ["--reset-session"]
            app.launch()
            let urlField = app.textFields["pairing.urlField"]
            XCTAssertTrue(urlField.waitForExistence(timeout: 10), "Pairing URL field should appear")
            urlField.tap()
            urlField.typeText(pairingURL)
            app.buttons["pairing.connectButton"].tap()
        }

        let content = row(app, "Plan a greeting in main.rs")
        XCTAssertTrue(content.waitForExistence(timeout: 30), "The inbox should list the seeded threads")
        settle(2)
        capture("inbox")

        content.tap()
        settle(2)
        capture("thread")
        let composer = app.textViews.firstMatch.exists ? app.textViews.firstMatch : app.textFields.firstMatch
        if composer.waitForExistence(timeout: 5) {
            composer.tap()
            settle(1.5)
            capture("keyboard")
        }
        back(app)
        if app.keyboards.count > 0 { back(app) }

        for (title, name) in [("Clean the build folder", "approval"), ("Pick the cache store", "question")] {
            let target = row(app, title)
            if target.waitForExistence(timeout: 10) {
                target.tap()
                settle(2)
                capture(name)
                back(app)
            }
        }

        if tap(app, ["workspace.tab.tasks", "Tasks"]) { settle(3); capture("tasks") }
        if tap(app, ["workspace.tab.pullRequests", "Pull requests"]) { settle(3); capture("prs") }
        if tap(app, ["workspace.tab.threads", "Threads"]) { settle(1) }
        if tap(app, ["workspace.searchButton", "Search"]) {
            settle(1)
            if let tip = first(app, ["Continue"], timeout: 2) { tip.tap() }
            capture("search")
            _ = tap(app, ["workspace.cancelSearchButton", "Cancel", "Close"])
            settle(1)
        }
        if tap(app, ["workspace.settingsButton", "Open settings"]) {
            settle(1.5)
            capture("settings")
            if !tap(app, ["settings.closeButton", "Close", "Done"]) { app.swipeDown() }
            settle(1)
        }
        if tap(app, ["inbox.newThreadButton", "New chat"]) { settle(1.5); capture("new-chat") }
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
