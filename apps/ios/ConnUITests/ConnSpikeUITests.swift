import UIKit
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
        app.launchArguments = ["--reset-session", "--manual-pairing"]
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
    func testOrbitDesktopThreads() throws {
        guard let label = ProcessInfo.processInfo.environment["CONN_TEST_DESKTOP_LABEL"] else {
            throw XCTSkip("Requires an authorized Orbit desktop with active threads")
        }
        let app = XCUIApplication()
        app.launchArguments = ["--reset-session"]
        app.launch()
        let filter = app.buttons["Filter threads"]
        XCTAssertTrue(filter.waitForExistence(timeout: 90))
        filter.tap()
        let option = app.buttons[label].firstMatch
        if !option.waitForExistence(timeout: 5) {
            app.coordinate(withNormalizedOffset: CGVector(dx: 0.1, dy: 0.8)).tap()
            filter.tap()
        }
        XCTAssertTrue(option.waitForExistence(timeout: 30))
        option.tap()
        let thread = app.buttons.matching(NSPredicate(format: "identifier BEGINSWITH 'inbox.thread.'")).firstMatch
        XCTAssertTrue(thread.waitForExistence(timeout: 90))
        let title = thread.label
        thread.tap()
        XCTAssertTrue(app.descendants(matching: .any)["thread.composer"].waitForExistence(timeout: 30))
        XCTAssertFalse(title.isEmpty)
    }

    func testLaunchVisualStates() async throws {
        let env = ProcessInfo.processInfo.environment
        guard env["CONN_CAPTURE_LAUNCH"] == "1" else { throw XCTSkip("Launch appearance snapshots") }
        let theme = env["CONN_APPEARANCE"] ?? "light"
        let app = XCUIApplication()
        app.launchEnvironment["CONN_TEST_APPEARANCE"] = theme
        for phase in ["splash", "checking", "setup", "finalizing", "no-gateway", "no-network"] {
            if let fixture = env["CONN_TEST_TASK_GATEWAY"].flatMap(URL.init(string:)) {
                _ = try await URLSession.shared.data(from: fixture.appending(path: "fixture-mode/" + (phase == "no-network" ? "unknown-node" : "normal")))
            }
            app.launchEnvironment["CONN_TEST_LAUNCH_PHASE"] = phase
            app.launchEnvironment["CONN_TEST_TASK_GATEWAY"] = env["CONN_TEST_TASK_GATEWAY"]
            app.launchArguments = ["--reset-session", phase == "no-gateway" ? "--test-unreachable-gateway" : phase == "no-network" ? "--test-orbit" : "--manual-pairing"]
            app.launch()
            if phase.hasPrefix("no-") {
                XCTAssertTrue(app.staticTexts["orbit.errorText"].waitForExistence(timeout: 20))
            } else if phase != "splash" {
                XCTAssertTrue(app.staticTexts["orbit.connecting"].waitForExistence(timeout: 10))
            }
            let shot = XCTAttachment(screenshot: XCUIScreen.main.screenshot())
            shot.name = theme + "-launch-" + phase
            shot.lifetime = .keepAlways
            add(shot)
            app.terminate()
        }
    }

    func testComposerVisualStates() throws {
        let env = ProcessInfo.processInfo.environment
        guard let pairing = env["CONN_PANEL_PAIRING"] else { throw XCTSkip("Requires an isolated panel fixture") }
        let app = XCUIApplication()
        let theme = env["CONN_APPEARANCE"] ?? "light"
        app.launchEnvironment["CONN_TEST_APPEARANCE"] = theme
        app.launchArguments = ["--reset-session", "--manual-pairing"]
        app.launch()
        let url = app.textFields["pairing.urlField"]
        XCTAssertTrue(url.waitForExistence(timeout: 10))
        url.tap()
        url.typeText(pairing)
        app.buttons["pairing.connectButton"].tap()
        func capture(_ name: String) {
            let shot = XCTAttachment(screenshot: XCUIScreen.main.screenshot())
            shot.name = theme + "-" + name
            shot.lifetime = .keepAlways
            add(shot)
        }
        for scenario in ["approval-command", "approval-long", "approval-session", "approval-two", "approval-six", "question-single", "question-long", "question-multi-1"] {
            let row = app.buttons["inbox.thread.fidelity-" + scenario]
            if !row.waitForExistence(timeout: 10) || !row.isHittable { app.swipeUp() }
            XCTAssertTrue(row.isHittable, scenario)
            row.tap()
            let panel = app.descendants(matching: .any).matching(NSPredicate(format: "identifier BEGINSWITH %@", scenario.hasPrefix("approval") ? "thread.approval." : "thread.question.")).firstMatch
            XCTAssertTrue(panel.waitForExistence(timeout: 10), scenario)
            capture("thread-" + scenario)
            if scenario.hasPrefix("question") && scenario != "question-long" {
                let option = app.buttons.matching(NSPredicate(format: "identifier BEGINSWITH 'question.option.'")).firstMatch
                option.tap()
                if scenario == "question-single" { capture("thread-question-selected") }
                else {
                    let next = app.buttons["question.next"]
                    if next.exists && next.isHittable { next.tap() }
                    let second = app.buttons.matching(NSPredicate(format: "identifier BEGINSWITH 'question.option.'"))
                    if second.count >= 2 { second.element(boundBy: 0).tap(); second.element(boundBy: 1).tap() }
                    capture("thread-question-multi-2")
                    if next.exists && next.isHittable { next.tap() }
                    capture("thread-question-cant-submit")
                    let composer = app.textViews.firstMatch.exists ? app.textViews.firstMatch : app.textFields.firstMatch
                    composer.tap()
                    composer.typeText("Use the private network")
                    capture("thread-question-multi-3")
                }
            }
            app.navigationBars.buttons.firstMatch.tap()
            app.swipeDown()
        }
    }

    func testFeedVisualStates() throws {
        let env = ProcessInfo.processInfo.environment
        guard let pairing = env["CONN_FEED_PAIRING"] else { throw XCTSkip("Requires the feed fixture") }
        let app = XCUIApplication()
        let theme = env["CONN_APPEARANCE"] ?? "light"
        app.launchEnvironment["CONN_TEST_APPEARANCE"] = theme
        app.launchArguments = ["--reset-session", "--manual-pairing"]
        app.launch()
        let url = app.textFields["pairing.urlField"]
        XCTAssertTrue(url.waitForExistence(timeout: 10))
        url.tap()
        url.typeText(pairing)
        app.buttons["pairing.connectButton"].tap()
        func capture(_ name: String) {
            let shot = XCTAttachment(screenshot: XCUIScreen.main.screenshot())
            shot.name = theme + "-" + name
            shot.lifetime = .keepAlways
            add(shot)
        }
        let rows = app.buttons.matching(NSPredicate(format: "identifier BEGINSWITH 'inbox.thread.'"))
        XCTAssertTrue(rows.firstMatch.waitForExistence(timeout: 20))
        XCTAssertEqual(rows.count, 1)
        capture("thread-list-demo")
        rows.firstMatch.tap()
        XCTAssertTrue(app.buttons["thread.moreButton"].waitForExistence(timeout: 10))
        capture("thread")
        let diff = app.buttons["Open diff"].firstMatch
        if diff.exists && diff.isHittable {
            capture("feed-changes-card")
            diff.tap()
            XCTAssertTrue(app.navigationBars["Changed files"].waitForExistence(timeout: 8))
            capture("feed-review")
            app.buttons["Done"].firstMatch.tap()
        }
        func visible(_ text: String) -> Bool {
            let label = app.staticTexts.matching(NSPredicate(format: "label CONTAINS[c] %@", text)).firstMatch
            return label.exists && label.isHittable && app.frame.contains(CGPoint(x: label.frame.midX, y: label.frame.midY))
        }
        for _ in 0..<16 where !visible("Map every stalled Orbit thread") { app.swipeDown() }
        if visible("Map every stalled Orbit thread") { capture("feed-at-0") }
        var captured = Set<String>()
        for _ in 0..<18 {
            for (text, name) in [("Check stalled pull requests", "feed-disclosure-card"),
                                 ("Code block lab", "feed-at-25"),
                                 ("Review the stalled Orbit pull requests", "feed-gallery-card"),
                                 ("Review service token", "feed-at-50"),
                                 ("review-notes.txt", "feed-at-75")] where !captured.contains(name) && visible(text) {
                capture(name)
                captured.insert(name)
            }
            if diff.exists && diff.isHittable { break }
            app.swipeUp()
        }
    }

    func testJumpFromReadingAndHistory() throws {
        let env = ProcessInfo.processInfo.environment
        guard let pairing = env["CONN_READING_PAIRING"] else { throw XCTSkip("Requires the long reading thread fixture") }
        let app = XCUIApplication()
        let theme = env["CONN_APPEARANCE"] ?? "light"
        app.launchEnvironment["CONN_TEST_APPEARANCE"] = theme
        app.launchArguments = ["--reset-session", "--manual-pairing", "-AppleLocale", "en_GB"]
        app.launch()
        let url = app.textFields["pairing.urlField"]
        XCTAssertTrue(url.waitForExistence(timeout: 15))
        url.tap()
        url.typeText(pairing)
        app.buttons["pairing.connectButton"].tap()
        let row = app.buttons.containing(NSPredicate(format: "label CONTAINS %@", "Long reading thread")).firstMatch
        XCTAssertTrue(row.waitForExistence(timeout: 20))
        row.tap()

        func capture(_ state: String) {
            let shot = XCTAttachment(screenshot: XCUIScreen.main.screenshot())
            shot.name = theme + "-" + state
            shot.lifetime = .keepAlways
            add(shot)
        }
        let newest = app.staticTexts.matching(NSPredicate(format: "label BEGINSWITH %@", "The first native comparisons")).firstMatch
        let jumps = app.buttons.matching(identifier: "thread.scrollToEnd")
        let jump = jumps.firstMatch
        func assertAtLatest() {
            XCTAssertTrue(newest.wait(for: \.isHittable, toEqual: true, timeout: 10))
            XCTAssertTrue(jump.waitForNonExistence(timeout: 5))
        }
        assertAtLatest()
        capture("latest")
        let feed = app.scrollViews.firstMatch
        feed.swipeDown()
        XCTAssertTrue(jump.waitForExistence(timeout: 5))
        XCTAssertEqual(jumps.count, 1)
        capture("reading")
        jump.tap()
        assertAtLatest()

        app.buttons["thread.moreButton"].tap()
        app.buttons["Thread outline"].tap()
        let prompt = "Reading prompt 04"
        let search = app.searchFields.firstMatch
        XCTAssertTrue(search.waitForExistence(timeout: 10))
        search.tap()
        search.typeText(prompt)
        let match = app.buttons.matching(NSPredicate(format: "label CONTAINS %@", prompt)).firstMatch
        XCTAssertTrue(match.waitForExistence(timeout: 10))
        match.tap()
        XCTAssertTrue(app.staticTexts.matching(NSPredicate(format: "label BEGINSWITH %@", prompt)).firstMatch.wait(for: \.isHittable, toEqual: true, timeout: 10))
        capture("history")
        XCTAssertFalse(app.buttons["Back to latest"].exists)
        XCTAssertEqual(jumps.count, 1)
        let field = app.textFields["thread.composer"]
        XCTAssertFalse(field.isEnabled)
        jump.tap()
        assertAtLatest()
        XCTAssertTrue(field.isEnabled)

        let edge = app.coordinate(withNormalizedOffset: CGVector(dx: 0.005, dy: 0.5))
        edge.press(forDuration: 0.05, thenDragTo: app.coordinate(withNormalizedOffset: CGVector(dx: 0.85, dy: 0.5)))
        XCTAssertTrue(row.waitForExistence(timeout: 5))
        let excerpt = app.buttons.containing(NSPredicate(format: "label CONTAINS %@", "Conn iOS WireGuard Launch Experience")).firstMatch
        excerpt.tap()
        assertAtLatest()
        capture("excerpt")
    }

    func testWorkspaceRecords() async throws {
        let env = ProcessInfo.processInfo.environment
        guard let pairing = env["CONN_PAIRING_URL"] else { throw XCTSkip("Requires an isolated Conn server") }
        let appearance = env["CONN_APPEARANCE"] ?? "light"
        XCUIDevice.shared.appearance = appearance == "dark" ? .dark : .light
        let app = XCUIApplication()
        if let gateway = env["CONN_TEST_TASK_GATEWAY"].flatMap(URL.init(string:)) {
            _ = try await URLSession.shared.data(from: gateway.appending(path: "fixture-mode/normal"))
        }
        app.launchEnvironment["CONN_TEST_TASK_GATEWAY"] = env["CONN_TEST_TASK_GATEWAY"]
        app.launchEnvironment["CONN_TEST_APPEARANCE"] = appearance
        app.launchArguments = ["--reset-session", "--manual-pairing"]
        app.launch()
        let field = app.textFields["pairing.urlField"]
        XCTAssertTrue(field.waitForExistence(timeout: 10))
        field.tap()
        field.typeText(pairing)
        app.buttons["pairing.connectButton"].tap()
        func capture(_ name: String) {
            let attachment = XCTAttachment(screenshot: XCUIScreen.main.screenshot())
            attachment.name = "\(appearance)-\(name)"
            attachment.lifetime = .keepAlways
            add(attachment)
        }
        let fixture = env["CONN_TEST_TASK_GATEWAY"].flatMap(URL.init(string:))
        func mode(_ name: String) async throws {
            guard let fixture else { return }
            let (_, response) = try await URLSession.shared.data(from: fixture.appending(path: "fixture-mode/" + name))
            XCTAssertEqual((response as? HTTPURLResponse)?.statusCode, 200)
        }
        try await mode("normal")
        let threads = app.buttons["workspace.tab.threads"]
        let ready = threads.waitForExistence(timeout: 25)
        if !ready { capture("workspace-failure") }
        XCTAssertTrue(ready)
        threads.tap()
        let firstThread = app.buttons.matching(NSPredicate(format: "identifier BEGINSWITH 'inbox.thread.'")).firstMatch
        XCTAssertTrue(firstThread.waitForExistence(timeout: 15))
        capture("threads")
        app.buttons["workspace.searchButton"].tap()
        capture("bottom-search")
        app.buttons["workspace.cancelSearch"].tap()
        app.buttons["Filter threads"].tap()
        capture("thread-list-populated-filter")
        XCTAssertTrue(app.descendants(matching: .any).matching(NSPredicate(format: "label CONTAINS[c] %@", "project")).firstMatch.waitForExistence(timeout: 5))
        if let project = env["CONN_TEST_FILTER_PROJECT"] {
            app.buttons[project].firstMatch.tap()
            XCTAssertTrue(firstThread.waitForExistence(timeout: 5))
            capture("filtered-threads")
            app.buttons["Filter threads"].tap()
            app.buttons["All projects"].firstMatch.tap()
        } else {
            app.coordinate(withNormalizedOffset: CGVector(dx: 0.1, dy: 0.8)).tap()
        }
        app.buttons["workspace.settingsButton"].tap()
        XCTAssertTrue(app.staticTexts["Environments"].waitForExistence(timeout: 5))
        capture("settings")
        app.buttons.containing(.staticText, identifier: "Environments").firstMatch.tap()
        capture("settings-environments")
        app.navigationBars.buttons.firstMatch.tap()
        app.buttons["settings.closeButton"].tap()
        app.buttons["inbox.newThreadButton"].tap()
        XCTAssertTrue(app.staticTexts["What should we work on?"].waitForExistence(timeout: 5))
        capture("general-draft")
        if fixture != nil {
            let input = app.textViews.firstMatch.exists ? app.textViews.firstMatch : app.textFields.firstMatch
            input.tap()
            input.typeText("Fix image attachments in Conn.")
            capture("new-chat-example")
        }
        if env["CONN_TEST_GENERAL_LAUNCH"] == "1" {
            let prompt = app.textViews.firstMatch.exists ? app.textViews.firstMatch : app.textFields.firstMatch
            prompt.tap()
            prompt.typeText("Check the fixture project.")
            app.buttons["Send"].firstMatch.tap()
            XCTAssertTrue(app.descendants(matching: .any)["thread.composer"].waitForExistence(timeout: 15))
            if app.buttons["Not now"].waitForExistence(timeout: 2) { app.buttons["Not now"].tap() }
            capture("general-thread")
        }
        app.navigationBars.buttons.firstMatch.tap()
        firstThread.tap()
        XCTAssertTrue(app.descendants(matching: .any)["thread.composer"].waitForExistence(timeout: 10))
        capture("thread")
        app.buttons.matching(NSPredicate(format: "label BEGINSWITH %@", "Model")).firstMatch.tap()
        XCTAssertTrue(app.buttons["modelPicker.confirm"].waitForExistence(timeout: 8))
        if fixture != nil {
            let providerRow = app.buttons.containing(.staticText, identifier: "Provider").firstMatch
            XCTAssertTrue(providerRow.waitForExistence(timeout: 10))
            capture("configuration")
            providerRow.tap()
            let provider = app.buttons["modelPicker.provider.claudeAgent"]
            XCTAssertTrue(provider.waitForExistence(timeout: 10))
            capture("configuration-providers")
            provider.tap()
            let model = app.buttons.matching(NSPredicate(format: "identifier BEGINSWITH 'modelPicker.model.'")).firstMatch
            XCTAssertTrue(model.waitForExistence(timeout: 10))
            capture("configuration-models")
            XCTAssertTrue(app.navigationBars["Claude"].exists)
            let search = app.textFields["modelPicker.search"]
            search.tap()
            search.typeText("sonnet")
            let sonnet = app.buttons["modelPicker.model.claude-sonnet-5-5"]
            XCTAssertTrue(sonnet.waitForExistence(timeout: 5))
            XCTAssertFalse(app.buttons["modelPicker.model.claude-opus-5-5"].exists)
            capture("configuration-models-search")
            sonnet.tap()
        }
        if env["CONN_TEST_PROVIDER_CATALOG"] == "1" {
            app.buttons.containing(.staticText, identifier: "Provider").firstMatch.tap()
            let provider = app.buttons.matching(NSPredicate(format: "identifier BEGINSWITH 'modelPicker.provider.'")).firstMatch
            XCTAssertTrue(provider.waitForExistence(timeout: 10))
            capture("providers")
            provider.tap()
            let model = app.buttons.matching(NSPredicate(format: "identifier BEGINSWITH 'modelPicker.model.'")).firstMatch
            XCTAssertTrue(model.waitForExistence(timeout: 10))
            capture("models")
            model.tap()
            let effort = app.buttons.matching(NSPredicate(format: "label BEGINSWITH %@", "Effort")).firstMatch
            XCTAssertTrue(effort.waitForExistence(timeout: 8))
            effort.tap()
            app.buttons["High"].firstMatch.tap()
            let speed = app.buttons.matching(NSPredicate(format: "label BEGINSWITH %@", "Speed")).firstMatch
            speed.tap()
            app.buttons["On"].firstMatch.tap()
        }
        capture("thread-settings")
        app.buttons["modelPicker.confirm"].tap()
        app.navigationBars.buttons.firstMatch.tap()
        if fixture != nil {
            try await mode("unavailable")
            app.buttons["workspace.tab.tasks"].tap()
            XCTAssertTrue(app.descendants(matching: .any)["tasks.error"].firstMatch.waitForExistence(timeout: 10))
            capture("tasks-unavailable")
            threads.tap()
            try await mode("normal")
        }
        app.buttons["workspace.tab.tasks"].tap()
        let task = env["CONN_TEST_TASK_ID"].map { app.descendants(matching: .any)["tasks.row." + $0].firstMatch } ?? app.descendants(matching: .any).matching(NSPredicate(format: "identifier BEGINSWITH 'tasks.row.'")).firstMatch
        if task.waitForExistence(timeout: 12) {
            capture("tasks")
            app.buttons["tasks.laneMenu"].tap()
            capture("tasks-loaded-filter")
            app.buttons.matching(NSPredicate(format: "label BEGINSWITH[c] %@", "In progress")).firstMatch.tap()
            task.tap()
            for section in ["Overview", "Subtasks", "Agents"] {
                app.buttons[section].tap()
                capture("task-" + section)
                if section == "Subtasks", env["CONN_TEST_TASK_GATEWAY"] != nil {
                    app.buttons.matching(NSPredicate(format: "identifier BEGINSWITH 'task.step.'")).firstMatch.tap()
                    capture("task-expanded")
                }
            }
            app.navigationBars.buttons.firstMatch.tap()
        } else {
            XCTAssertTrue(app.descendants(matching: .any)["tasks.error"].exists || app.staticTexts["tasks.empty"].exists)
            capture("tasks-response")
        }
        if let doneID = env["CONN_TEST_DONE_TASK_ID"] {
            app.buttons["tasks.laneMenu"].tap()
            app.descendants(matching: .any).matching(NSPredicate(format: "label BEGINSWITH[c] %@", "Done")).firstMatch.tap()
            let done = app.descendants(matching: .any)["tasks.row." + doneID].firstMatch
            for _ in 0..<8 where !done.isHittable { app.swipeUp() }
            XCTAssertTrue(done.isHittable)
            done.tap()
            app.buttons["Subtasks"].tap()
            let step = app.descendants(matching: .any).matching(NSPredicate(format: "identifier BEGINSWITH 'task.step.'")).firstMatch
            XCTAssertTrue(step.waitForExistence(timeout: 10))
            step.tap()
            capture("expanded-step")
            app.navigationBars.buttons.firstMatch.tap()
        }
        app.buttons["workspace.tab.pullRequests"].tap()
        let pr = app.buttons.matching(NSPredicate(format: "identifier BEGINSWITH 'pr.row.'")).firstMatch
        XCTAssertTrue(pr.waitForExistence(timeout: 40), "The test server should list at least one open pull request")
        app.buttons["Filter pull requests"].tap()
        capture("pull-requests-populated-filter")
        app.buttons.matching(NSPredicate(format: "label BEGINSWITH %@", "Draft (")).firstMatch.tap()
        capture("filtered-prs")
        app.buttons["Filter pull requests"].tap()
        app.buttons.matching(NSPredicate(format: "label BEGINSWITH %@", "All (")).firstMatch.tap()
        if fixture != nil { XCTAssertTrue(pr.label.contains("25d")) }
        capture("pull-requests")
        pr.tap()
        for section in ["Overview", "Checks", "Timeline", "Code"] {
            let tab = app.buttons[section]
            XCTAssertTrue(tab.waitForExistence(timeout: 20))
            tab.tap()
            if section == "Timeline" {
                if fixture != nil { XCTAssertTrue(app.staticTexts["Updated 25d ago"].exists) }
                let item = app.descendants(matching: .any).matching(NSPredicate(format: "identifier BEGINSWITH 'pr.timeline.'")).firstMatch
                XCTAssertTrue(item.waitForExistence(timeout: 30))
            }
            if section == "Checks", env["CONN_TEST_TASK_GATEWAY"] != nil {
                XCTAssertTrue(app.staticTexts["1m 12s"].waitForExistence(timeout: 8))
                app.buttons["Filter checks"].tap()
                capture("pr-detail-checks-filter")
                app.buttons.matching(NSPredicate(format: "label BEGINSWITH %@", "All")).firstMatch.tap()
            }
            if section != "Code" { capture("pr-" + section) }
        }
        let file = app.buttons.matching(NSPredicate(format: "identifier BEGINSWITH 'pr.file.'")).firstMatch
        XCTAssertTrue(file.waitForExistence(timeout: 30))
        capture("pr-Files")
        file.tap()
        let backToFiles = app.navigationBars.buttons.firstMatch
        XCTAssertTrue(backToFiles.waitForExistence(timeout: 10))
        capture("code-diff")
        let comment = app.buttons.matching(NSPredicate(format: "label BEGINSWITH %@", "Comment on line")).firstMatch
        if env["CONN_TEST_INLINE_FIXTURE"] == "1" {
            XCTAssertTrue(pairing.hasPrefix("http://127.0.0.1:"))
            XCTAssertTrue(app.navigationBars["ios-fixture.txt"].exists)
            XCTAssertTrue(comment.exists)
        }
        if comment.exists {
            comment.tap()
            XCTAssertTrue(app.buttons["Submit"].exists)
            XCTAssertFalse(app.buttons["Submit"].isEnabled)
            capture("inline-comment")
            if env["CONN_TEST_INLINE_FIXTURE"] == "1" {
                let field = app.textFields["Comment"]
                field.tap()
                field.typeText("Isolated line review")
                app.buttons["Submit"].tap()
                XCTAssertTrue(app.staticTexts["Isolated line review"].waitForExistence(timeout: 10))
                capture("inline-comment-posted")
            } else {
                app.buttons["Cancel"].tap()
            }
        }
        backToFiles.tap()
        app.navigationBars.buttons.firstMatch.tap()
        if fixture != nil {
            let running = app.buttons["pr.row.nckrtl/conn.1931"]
            running.tap()
            app.buttons["Checks"].tap()
            XCTAssertTrue(app.staticTexts["4 of 12 checks passed"].waitForExistence(timeout: 10))
            capture("pr-running-checks")
            app.buttons["Filter checks"].tap()
            capture("pr-detail-checks-filter")
            app.buttons.matching(NSPredicate(format: "label BEGINSWITH %@", "All")).firstMatch.tap()
            app.buttons["Code"].tap()
            let filter = app.buttons["Filter files"]
            if filter.waitForExistence(timeout: 10) {
                filter.tap()
                capture("pr-detail-code-filter")
                app.buttons.matching(NSPredicate(format: "label BEGINSWITH %@", "Changed")).firstMatch.tap()
            }
            app.navigationBars.buttons.firstMatch.tap()
            try await mode("empty")
            threads.tap()
            app.buttons["workspace.tab.pullRequests"].tap()
            XCTAssertTrue(app.staticTexts["No pull requests"].waitForExistence(timeout: 12))
            capture("pull-requests-empty")
            try await mode("normal")
        }
        threads.tap()
        firstThread.tap()
        let expectedTitle = app.navigationBars.firstMatch.identifier
        app.terminate()
        app.launchEnvironment["CONN_TEST_SAVED_SESSION"] = env["CONN_TEST_SAVED_SESSION"]
        app.launchArguments = []
        app.launch()
        if !app.descendants(matching: .any)["thread.composer"].waitForExistence(timeout: 5),
           env["CONN_TEST_SAVED_SESSION"] == nil, let secondPairing = env["CONN_RESTORE_PAIRING_URL"] {
            app.launchArguments = ["--manual-pairing"]
            app.launch()
            let field = app.textFields["pairing.urlField"]
            XCTAssertTrue(field.waitForExistence(timeout: 10))
            field.tap()
            field.typeText(secondPairing)
            app.buttons["pairing.connectButton"].tap()
        }
        let restored = app.descendants(matching: .any)["thread.composer"].waitForExistence(timeout: 15)
        if !restored { capture("restore-failure") }
        XCTAssertTrue(restored)
        XCTAssertEqual(app.navigationBars.firstMatch.identifier, expectedTitle)
        capture("restored-thread")

    }

    func testSavedWorkspaceGatewayFailure() async throws {
        let env = ProcessInfo.processInfo.environment
        guard let pairing = env["CONN_PAIRING_URL"], let saved = env["CONN_TEST_SAVED_SESSION"],
              let gateway = env["CONN_TEST_TASK_GATEWAY"].flatMap(URL.init(string:)) else {
            throw XCTSkip("Requires a disposable gateway and saved Orbit session")
        }
        func mode(_ value: String) async throws {
            let (_, response) = try await URLSession.shared.data(from: gateway.appending(path: "fixture-mode/" + value))
            XCTAssertEqual((response as? HTTPURLResponse)?.statusCode, 200)
        }
        let app = XCUIApplication()
        let theme = env["CONN_APPEARANCE"] ?? "light"
        app.launchEnvironment["CONN_TEST_APPEARANCE"] = theme
        app.launchEnvironment["CONN_TEST_TASK_GATEWAY"] = gateway.absoluteString
        app.launchArguments = ["--reset-session", "--manual-pairing"]
        try await mode("gateway-failure")
        app.launch()
        let field = app.textFields["pairing.urlField"]
        XCTAssertTrue(field.waitForExistence(timeout: 10))
        field.tap()
        field.typeText(pairing)
        app.buttons["pairing.connectButton"].tap()
        let row = app.buttons["inbox.thread.thread-parity-pinned"]
        XCTAssertTrue(row.waitForExistence(timeout: 15))
        XCTAssertTrue(app.buttons["Retry discovery"].waitForExistence(timeout: 12))
        XCTAssertFalse(app.alerts["Couldn’t reach the Orbit server"].exists)
        row.tap()
        let reply = app.staticTexts.containing(NSPredicate(format: "label CONTAINS[c] %@", "Seeded parity response")).firstMatch
        XCTAssertTrue(reply.waitForExistence(timeout: 10))
        app.navigationBars.buttons.firstMatch.tap()
        app.terminate()
        app.launchArguments = []
        app.launchEnvironment["CONN_TEST_SAVED_SESSION"] = saved
        try await mode("gateway-failure")
        app.launch()
        let alert = app.alerts["Couldn’t reach the Orbit server"]
        XCTAssertTrue(alert.waitForExistence(timeout: 20))
        let evidence = XCTAttachment(screenshot: XCUIScreen.main.screenshot())
        evidence.name = theme + "-saved-gateway-failure"
        evidence.lifetime = .keepAlways
        add(evidence)
        alert.buttons["Use offline"].tap()
        XCTAssertTrue(row.waitForExistence(timeout: 8))
        XCTAssertFalse(alert.exists)
        row.tap()
        XCTAssertTrue(reply.waitForExistence(timeout: 8))
        app.navigationBars.buttons.firstMatch.tap()
        app.terminate()
        app.launch()
        XCTAssertTrue(alert.waitForExistence(timeout: 20))
        try await mode("normal")
        alert.buttons["Try again"].tap()
        let newThread = app.buttons["inbox.newThreadButton"]
        let connected = XCTNSPredicateExpectation(predicate: NSPredicate(format: "exists == true AND enabled == true"), object: newThread)
        await fulfillment(of: [connected], timeout: 20)
        XCTAssertFalse(app.staticTexts["Not connected"].exists)
        XCTAssertFalse(alert.exists)
        XCTAssertTrue(row.exists)
        app.buttons["workspace.tab.pullRequests"].tap()
        XCTAssertTrue(app.buttons["pr.row.hardimpactdev/hauzer.140"].waitForExistence(timeout: 15))
    }

    func testCachedThreadWhileDisconnected() async throws {
        let env = ProcessInfo.processInfo.environment
        guard let pairing = env["CONN_PAIRING_URL"],
              let endpoint = env["CONN_DISCONNECT_FIXTURE_URL"], let url = URL(string: endpoint) else {
            throw XCTSkip("Requires a disposable server with a stop endpoint")
        }
        let app = XCUIApplication()
        let theme = env["CONN_APPEARANCE"] ?? "light"
        app.launchEnvironment["CONN_TEST_APPEARANCE"] = theme
        app.launchArguments = ["--reset-session", "--manual-pairing"]
        app.launch()
        let field = app.textFields["pairing.urlField"]
        XCTAssertTrue(field.waitForExistence(timeout: 10))
        field.tap()
        field.typeText(pairing)
        app.buttons["pairing.connectButton"].tap()
        let row = app.buttons["inbox.thread.thread-parity-pinned"]
        XCTAssertTrue(row.waitForExistence(timeout: 20))
        row.tap()
        let reply = app.staticTexts.containing(NSPredicate(format: "label CONTAINS[c] %@", "Seeded parity response")).firstMatch
        XCTAssertTrue(reply.waitForExistence(timeout: 10))
        let (_, response) = try await URLSession.shared.data(from: url)
        XCTAssertEqual((response as? HTTPURLResponse)?.statusCode, 200)
        XCTAssertTrue(app.staticTexts["Not connected"].waitForExistence(timeout: 15))
        XCTAssertFalse(app.alerts["Couldn’t reach the Orbit server"].exists)
        XCTAssertTrue(reply.exists)
        app.navigationBars.buttons.firstMatch.tap()
        XCTAssertTrue(row.waitForExistence(timeout: 10))
        let offline = XCTAttachment(screenshot: XCUIScreen.main.screenshot())
        offline.name = theme + "-launch-offline"
        offline.lifetime = .keepAlways
        add(offline)
        row.tap()
        XCTAssertTrue(reply.waitForExistence(timeout: 10))
        let evidence = XCTAttachment(screenshot: XCUIScreen.main.screenshot())
        evidence.name = "offline-cached-thread"
        evidence.lifetime = .keepAlways
        add(evidence)
    }

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
        app.launchArguments = ["--reset-session", "--manual-pairing"]
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
        // React Native's controlled fields drop keys and focus under load; a paste is one event.
        func pasteInto(_ app: XCUIApplication, _ field: XCUIElement, _ text: String) {
            UIPasteboard.general.string = text
            field.tap()
            settle(1)
            field.press(forDuration: 1.2)
            let paste = app.menuItems["Paste"].firstMatch
            if paste.waitForExistence(timeout: 5) { paste.tap() }
            let allow = springboard.buttons["Allow Paste"].firstMatch
            if allow.waitForExistence(timeout: 2) { allow.tap() }
            settle(1)
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
            app.terminate()
            app.launch()
            settle(4)
            // Already paired from an earlier run: the inbox lists the seeded thread.
            let seeded = row(app, "Plan a greeting in main.rs")
            if !(seeded.waitForExistence(timeout: 20) && seeded.isHittable) {
                // Expo's own form (`ConnectionsNewRouteScreen.tsx`): Address and Code, then the
                // header's checkmark, "Add environment". A production build ignores pairing links.
                let parts = pairingURL.components(separatedBy: "/pair#token=")
                XCTAssertEqual(parts.count, 2, "pairing URL should be <origin>/pair#token=<code>")
                let addEnvironment = first(app, ["Add environment"], timeout: 45)
                XCTAssertNotNil(addEnvironment, "Expo should offer Add environment")
                addEnvironment?.tap()
                settle(2)
                let address = app.textFields.matching(
                    NSPredicate(format: "placeholderValue == %@", "192.168.1.100:3773")).firstMatch
                XCTAssertTrue(address.waitForExistence(timeout: 30), "the pairing form should open")
                pasteInto(app, address, parts[0].replacingOccurrences(of: "http://", with: ""))
                let code = app.textFields.matching(
                    NSPredicate(format: "placeholderValue == %@", "Pairing code")).firstMatch
                pasteInto(app, code, parts.count > 1 ? parts[1] : "")
                let submit = app.navigationBars.buttons["Add environment"].firstMatch
                if submit.waitForExistence(timeout: 5) { submit.tap() } else { code.typeText("\n") }
                settle(4)
                // Pairing ends on Settings › Environments; close the sheet to reach the inbox.
                for _ in 0..<3 {
                    guard let close = first(app, ["Close", "close"], timeout: 8) else { break }
                    close.tap()
                    settle(1.5)
                }
            }
        } else {
            app = XCUIApplication()
            app.launchArguments = ["--reset-session", "--manual-pairing"]
            app.launch()
            let urlField = app.textFields["pairing.urlField"]
            XCTAssertTrue(urlField.waitForExistence(timeout: 10), "Pairing URL field should appear")
            pasteInto(app, urlField, pairingURL)
            app.buttons["pairing.connectButton"].tap()
        }

        let content = row(app, "Plan a greeting in main.rs")
        XCTAssertTrue(content.waitForExistence(timeout: 60), "The inbox should list the seeded threads")
        settle(2)
        // Pairs the showcase simulator and leaves the app on the inbox.
        if env["CONN_PAIR_ONLY"] == "1" { return }
        capture("inbox")

        content.tap()
        settle(2)
        capture("thread")
        // Part-way up the feed: content runs under the floating composer and the top edge blur.
        let feed = app.scrollViews.firstMatch.exists ? app.scrollViews.firstMatch : app.collectionViews.firstMatch
        if feed.exists {
            feed.swipeDown(velocity: .slow)
            settle(1.5)
            // The down-chevron above the composer shows here (`FloatingWorkingControl`).
            capture("thread-scrolled")
            let toEnd = app.buttons.matching(NSPredicate(format: "label == %@", "Scroll to end")).firstMatch
            if toEnd.exists && toEnd.isHittable { toEnd.tap(); settle(1.2) }
        }
        // The `+` menu (Expo), or the pill without it (Swift: the core cannot send attachments).
        if tap(app, ["Add attachment"]) {
            settle(1)
            capture("attachments")
            app.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.3)).tap()
            settle(0.8)
        } else {
            capture("attachments")
        }
        // The model chip opens the thread settings sheet.
        let modelChip = app.buttons.matching(NSPredicate(
            format: "identifier == %@ OR label BEGINSWITH %@ OR label BEGINSWITH %@",
            "composer.modelButton", "Model and reasoning settings", "Model, "
        )).firstMatch
        if modelChip.waitForExistence(timeout: 5) && modelChip.isHittable {
            modelChip.tap()
            settle(2)
            capture("model-picker")
            if !tap(app, ["Cancel thread settings", "Close"]) { app.swipeDown() }
            settle(1.2)
        } else {
            capture("missing-model-picker")
        }
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
            } else {
                capture("missing-\(name)")
            }
        }

        // SwiftUI hosts the switcher inside one UIToolbar item, where XCUITest cannot hit its
        // buttons; the Swift app falls back to their place on the bar (402pt-wide phone).
        func barTap(_ keys: [String], swiftX: CGFloat) -> Bool {
            if tap(app, keys) { return true }
            guard !expo else { return false }
            app.coordinate(withNormalizedOffset: CGVector(dx: swiftX, dy: 0.936)).tap()
            return true
        }
        if barTap(["workspace.tab.tasks", "Tasks"], swiftX: 0.43) { settle(3); capture("tasks") }
        if barTap(["workspace.tab.pullRequests", "Pull requests"], swiftX: 0.57) {
            settle(3)
            capture("prs")
            // PR search: the field and `+`, with no filter menu.
            if barTap(["workspace.searchButton", "Search"], swiftX: 0.71) {
                settle(1.5)
                if let tip = first(app, ["Continue"], timeout: 2) { tip.tap() }
                capture("prs-search")
                if !tap(app, ["workspace.cancelSearchButton", "Cancel", "Close"]) { app.swipeDown() }
                settle(1.5)
            }
        }
        if barTap(["workspace.tab.threads", "Threads"], swiftX: 0.29) { settle(1) }
        if barTap(["workspace.searchButton", "Search"], swiftX: 0.71) {
            settle(1.5)
            if let tip = first(app, ["Continue"], timeout: 2) { tip.tap() }
            capture("search")
            if !tap(app, ["workspace.cancelSearchButton", "Cancel", "Close"]) { app.swipeDown() }
            settle(1.5)
        }
        if barTap(["workspace.settingsButton", "Open settings"], swiftX: 0.115) {
            settle(2)
            capture("settings")
            if !tap(app, ["settings.closeButton", "Close", "Done"]) { app.swipeDown() }
            settle(1.5)
        }
        if barTap(["inbox.newThreadButton", "New chat"], swiftX: 0.885) { settle(2); capture("new-chat") }
    }

    /// With no saved session the app connects through Orbit. A simulator is no Orbit Node, so it
    /// shows why it failed, then "Connect manually" opens the pairing form.
    func testOrbitLaunchFailureFallsBackToManualPairing() throws {
        let env = ProcessInfo.processInfo.environment
        let screensDir = env["CONN_SCREENS_DIR"]
        let suffix = env["CONN_SCREEN_SUFFIX"] ?? ""
        let app = XCUIApplication()
        app.launchArguments = ["--reset-session", "--test-unreachable-gateway"]
        app.launch()

        let error = app.staticTexts["orbit.errorText"]
        XCTAssertTrue(error.waitForExistence(timeout: 60), "the Orbit failure shows")
        XCTAssertTrue(app.buttons["orbit.retryButton"].exists, "Try again shows")
        app.buttons["orbit.retryButton"].tap()
        XCTAssertTrue(error.waitForExistence(timeout: 15))
        saveScreenshot(named: "orbit-failed\(suffix)", dir: screensDir)

        app.buttons["orbit.manualButton"].tap()
        XCTAssertTrue(app.textFields["pairing.urlField"].waitForExistence(timeout: 5), "the pairing form shows")
        saveScreenshot(named: "orbit-manual\(suffix)", dir: screensDir)
    }

    /// Pairing's "Paste from Clipboard" takes a URL item ("Copy Link"), a string item, and says so
    /// when the clipboard is empty; a long-press paste into the field takes a URL item too.
    func testPairingPasteTakesURLAndStringItems() throws {
        let app = XCUIApplication()
        app.launchArguments = ["--reset-session", "--manual-pairing"]
        app.launch()
        let springboard = XCUIApplication(bundleIdentifier: "com.apple.springboard")
        let field = app.textFields["pairing.urlField"]
        let paste = app.buttons["pairing.pasteButton"]
        XCTAssertTrue(field.waitForExistence(timeout: 10), "the pairing form shows")
        func allowPaste() {
            for alertApp in [springboard, app] {
                let allow = alertApp.buttons["Allow Paste"].firstMatch
                if allow.waitForExistence(timeout: 2) { allow.tap(); return }
            }
        }
        func clearField() {
            let clear = app.buttons["Clear URL"]
            if clear.exists { clear.tap() }
        }

        let link = "http://127.0.0.1:3899/pair#token=url-item"
        // "Copy Link" stores a `public.url` item. (UIKit may still offer it as a string here.)
        UIPasteboard.general.setItems([["public.url": URL(string: link)!]])
        paste.tap()
        allowPaste()
        XCTAssertEqual(field.value as? String, link, "a URL item fills the field")
        clearField()

        UIPasteboard.general.string = "  http://127.0.0.1:3899/pair#token=string-item \n"
        paste.tap()
        allowPaste()
        XCTAssertEqual(field.value as? String, "http://127.0.0.1:3899/pair#token=string-item",
                       "a string item fills the field, trimmed")
        clearField()

        UIPasteboard.general.items = []
        paste.tap()
        allowPaste()
        let error = app.staticTexts["pairing.errorText"]
        XCTAssertTrue(error.waitForExistence(timeout: 5), "an empty clipboard says why nothing pasted")
        XCTAssertTrue(error.label.hasPrefix("The clipboard has no pairing URL"), "the empty-clipboard message")

        UIPasteboard.general.setItems([["public.url": URL(string: link)!]])
        field.tap()
        field.press(forDuration: 1.2)
        let menuPaste = app.menuItems["Paste"].firstMatch
        XCTAssertTrue(menuPaste.waitForExistence(timeout: 5), "the field offers Paste")
        menuPaste.tap()
        allowPaste()
        XCTAssertEqual(field.value as? String, link, "a long-press paste takes a URL item")
    }

    /// Writes the running app's accessibility tree to `CONN_DUMP_PATH` (layout debugging).
    func testDumpHierarchy() throws {
        guard let path = ProcessInfo.processInfo.environment["CONN_DUMP_PATH"] else {
            throw XCTSkip("Set CONN_DUMP_PATH")
        }
        let app = XCUIApplication()
        app.activate()
        RunLoop.current.run(until: Date().addingTimeInterval(2))
        try app.debugDescription.write(toFile: path, atomically: true, encoding: .utf8)
    }

    func testAtomicThreadInventory() async throws {
        let env = ProcessInfo.processInfo.environment
        guard let fixture = env["CONN_INVENTORY_FIXTURE"].flatMap(URL.init(string:)),
              let primary = env["CONN_PAIRING_URL"], let linked = env["CONN_LINKED_PAIRING_URL"] else {
            throw XCTSkip("Run apps/ios/scripts/thread-inventory-fixture.mjs with a simulator UDID")
        }
        let app = XCUIApplication()
        func tap(_ element: XCUIElement) {
            XCTAssertTrue(element.waitForExistence(timeout: 15))
            element.tap()
        }
        func step(_ name: String) async throws {
            let (_, response) = try await URLSession.shared.data(from: fixture.appending(path: name))
            XCTAssertEqual((response as? HTTPURLResponse)?.statusCode, 200)
        }
        var firstRowY: CGFloat?
        func expectRows(_ active: [String], _ settled: [String] = [], count: Int? = nil, phase: String) {
            let header = app.staticTexts["inbox.threadCount"]
            XCTAssertEqual(header.label, "\(count ?? (active.count + settled.count)) threads", phase)
            XCTAssertFalse(app.buttons["Retry"].exists)
            XCTAssertFalse(app.buttons["Retry discovery"].exists)
            XCTAssertFalse(app.staticTexts.matching(NSPredicate(format:
                "label BEGINSWITH 'Loading ' OR label BEGINSWITH 'Environment discovery:' OR label CONTAINS 'Not connected'")).firstMatch.exists)
            let query = app.buttons.matching(NSPredicate(
                format: "identifier BEGINSWITH 'inbox.thread.' OR identifier BEGINSWITH 'inbox.settledThread.'"
            ))
            let expected = active.map { "inbox.thread." + $0 } + settled.map { "inbox.settledThread." + $0 }
            let actual = query.allElementsBoundByIndex.map(\.identifier)
            XCTAssertEqual(actual, expected, phase)
            let y = query.firstMatch.frame.minY
            if let firstRowY { XCTAssertEqual(y, firstRowY, accuracy: 1, phase) }
            else { firstRowY = y }
            print("\(phase) → \(actual), header \(header.label), first row y=\(y)")
            let shot = XCTAttachment(screenshot: app.screenshot())
            shot.name = phase
            shot.lifetime = .keepAlways
            add(shot)
        }

        app.launchArguments = ["--reset-session", "--manual-pairing"]
        app.launchEnvironment["CONN_TEST_TASK_GATEWAY"] = "http://127.0.0.1:1"
        app.launch()
        let field = app.textFields["pairing.urlField"]
        tap(field)
        field.typeText(primary)
        tap(app.buttons["pairing.connectButton"])
        tap(app.buttons["workspace.settingsButton"])
        tap(app.buttons.containing(.staticText, identifier: "Environments").firstMatch)
        tap(app.buttons["Link environment"])
        let linkedField = app.alerts.textFields.firstMatch
        tap(linkedField)
        linkedField.typeText(linked)
        tap(app.alerts.buttons["Connect"])
        tap(app.navigationBars.buttons["Settings"])
        tap(app.buttons["settings.closeButton"])
        XCTAssertTrue(app.buttons["inbox.thread.old-linked"].waitForExistence(timeout: 15))
        expectRows(["old-linked", "old-primary"], phase: "Initial complete inventories")

        app.terminate()
        try await step("hold")
        app.launchArguments = []
        app.launch()
        XCTAssertTrue(app.buttons["inbox.thread.old-linked"].waitForExistence(timeout: 15))
        expectRows(["old-linked", "old-primary"], phase: "Cached inventory on cold launch")
        try await step("staged")
        expectRows(["old-linked", "old-primary"], phase: "Both refreshes held")
        try await step("primary")
        XCTAssertTrue(app.buttons["inbox.thread.p"].waitForExistence(timeout: 10))
        expectRows(["p", "b", "old-linked", "d"], count: 5, phase: "Only primary committed")
        try await step("interrupt")
        expectRows(["p", "b", "old-linked", "d"], count: 5, phase: "Linked refresh interrupted and replay held")
        try await step("linked")
        XCTAssertTrue(app.buttons["inbox.thread.q"].waitForExistence(timeout: 10))
        tap(app.buttons["inbox.settledHeader"])
        let active = ["p", "q", "a", "b", "c", "d"]
        expectRows(active, ["s", "t"], phase: "Both inventories committed")
        try await step("backfill")
        expectRows(active, ["s", "t"], phase: "Message backfill persisted")
        for phase in ["approval", "complete"] {
            try await step(phase)
            XCTAssertTrue(app.staticTexts["Primary b " + phase].waitForExistence(timeout: 10))
            expectRows(active, ["s", "t"], phase: phase)
        }
        try await step("settle")
        XCTAssertTrue(app.buttons["inbox.settledThread.a"].waitForExistence(timeout: 10))
        expectRows(["p", "q", "b", "c", "d"], ["a", "s", "t"], phase: "Explicit settle")
        try await step("unsettle")
        XCTAssertTrue(app.buttons["inbox.thread.s"].waitForExistence(timeout: 10))
        expectRows(["p", "q", "s", "b", "c", "d"], ["a", "t"], phase: "Explicit un-settle")
        tap(app.buttons["inbox.thread.b"])
        XCTAssertTrue(app.buttons["thread.moreButton"].waitForExistence(timeout: 10))
        XCTAssertTrue(app.staticTexts["Primary b complete"].exists)
    }

    func testOfflineLinkedChildKeepsItsPromptAcrossReconnect() async throws {
        let env = ProcessInfo.processInfo.environment
        guard let primaryURL = env["CONN_PAIRING_URL"],
              let linkedURL = env["CONN_LINKED_PAIRING_URL"],
              let fixture = env["CONN_OFFLINE_FIXTURE_URL"] else {
            throw XCTSkip("Requires two disposable servers and an offline fixture controller")
        }
        let app = XCUIApplication()
        let screenshots = env["CONN_SCREENS_DIR"]
        func transition(_ phase: String) async throws {
            let url = try XCTUnwrap(URL(string: fixture)?.appending(path: phase))
            let (_, response) = try await URLSession.shared.data(from: url)
            XCTAssertEqual((response as? HTTPURLResponse)?.statusCode, 200)
        }
        func tap(_ element: XCUIElement) {
            XCTAssertTrue(element.waitForExistence(timeout: 15), element.description)
            element.tap()
        }
        func capture(_ name: String) {
            let shot = XCTAttachment(screenshot: XCUIScreen.main.screenshot())
            shot.name = name
            shot.lifetime = .keepAlways
            add(shot)
            saveScreenshot(named: name, dir: screenshots)
        }

        app.launch()
        let urlField = app.textFields["pairing.urlField"]
        tap(urlField)
        urlField.typeText(primaryURL)
        tap(app.buttons["pairing.connectButton"])
        tap(app.buttons["workspace.settingsButton"])
        tap(app.buttons.containing(.staticText, identifier: "Environments").firstMatch)
        tap(app.buttons["Link environment"])
        let pairField = app.alerts.textFields.firstMatch
        tap(pairField)
        pairField.typeText(linkedURL)
        tap(app.alerts.buttons["Connect"])
        let descriptor = try XCTUnwrap(URL(string: "/.well-known/t3/environment", relativeTo: URL(string: linkedURL)))
        let (info, _) = try await URLSession.shared.data(from: descriptor)
        let identity = try XCTUnwrap((try JSONSerialization.jsonObject(with: info) as? [String: Any])?["environmentId"] as? String)
        try await transition("offline")
        app.terminate()
        app.launch()

        XCTAssertTrue(app.staticTexts["Pinned parity reference thread"].firstMatch.waitForExistence(timeout: 15))
        capture("01-offline-inbox")
        app.open(try XCTUnwrap(URL(string: "conn://thread/\(identity)/thread-parity-sub-1")))
        XCTAssertTrue(app.staticTexts["Only the linked environment has this reply"].firstMatch.waitForExistence(timeout: 15))
        capture("02-offline-linked-child")
        tap(app.buttons["thread.moreButton"])
        tap(app.buttons["Thread outline"])
        let outlineSearch = app.searchFields.firstMatch
        tap(outlineSearch)
        outlineSearch.typeText("Outline u 573")
        tap(app.buttons.matching(NSPredicate(format: "label CONTAINS %@", "Outline u 573")).firstMatch)
        let prompt = app.staticTexts["Outline u 573"].firstMatch
        XCTAssertTrue(prompt.waitForExistence(timeout: 10))
        XCTAssertTrue(prompt.isHittable)
        let anchorY = prompt.frame.midY
        capture("03-offline-anchor")

        XCUIDevice.shared.press(.home)
        try await transition("online")
        app.activate()
        try await transition("caught-up")
        XCTAssertTrue(prompt.isHittable)
        let reconnectedY = prompt.frame.midY
        print("Outline u 573 midpoint before foreground: \(anchorY), after catch-up: \(reconnectedY)")
        XCTAssertEqual(reconnectedY, anchorY, accuracy: 20)
        capture("04-reconnected-anchor")
        tap(app.buttons["thread.scrollToEnd"])
        let tail = app.staticTexts["Foreground catch-up reply"].firstMatch
        XCTAssertTrue(tail.waitForExistence(timeout: 15))
        XCTAssertTrue(tail.isHittable)
        capture("05-new-tail")
        tap(app.buttons["thread.moreButton"])
        tap(app.buttons["Thread outline"])
        tap(outlineSearch)
        let clearSearch = outlineSearch.buttons.firstMatch
        if clearSearch.exists { clearSearch.tap() }
        outlineSearch.typeText("Outline u 204")
        tap(app.buttons.matching(NSPredicate(format: "label CONTAINS %@", "Outline u 204")).firstMatch)
        let boundary = app.staticTexts["Outline u 204"].firstMatch
        XCTAssertTrue(boundary.waitForExistence(timeout: 10))
        XCTAssertTrue(boundary.isHittable)
        let feed = app.scrollViews.firstMatch
        let older = app.staticTexts["Outline u 200"].firstMatch
        for _ in 0..<12 where !older.isHittable {
            let start = feed.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.3))
            start.press(forDuration: 0.12, thenDragTo: feed.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.62)), withVelocity: .slow, thenHoldForDuration: 0.2)
        }
        XCTAssertTrue(older.isHittable)
        capture("06-server-page")
        // This prompt range lies more than one server page beyond the cache.
        let secondPage = app.staticTexts.matching(NSPredicate(format: "label MATCHES %@", "Outline u (1[0-4][0-9]|[1-9][0-9]?)"))
        var reachedSecondPage = false
        for _ in 0..<35 {
            reachedSecondPage = secondPage.allElementsBoundByIndex.contains { $0.isHittable }
            if reachedSecondPage { break }
            feed.swipeDown(velocity: .fast)
        }
        XCTAssertTrue(reachedSecondPage)
        capture("07-server-continuation")
        tap(app.buttons["thread.scrollToEnd"])
        XCTAssertTrue(app.staticTexts["Foreground catch-up reply"].firstMatch.waitForExistence(timeout: 10))
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
