import XCTest

/// The thread details sheet against `scripts/queued-messages-fixture.mjs`
/// (`PORT=47931 bun apps/ios/scripts/queued-messages-fixture.mjs .` from the repo root): thread
/// "qdetails" has four linked PRs and eleven child threads, "qplain" a folder without Git.
/// Skipped unless `CONN_PROOF_SERVER` is set (`TEST_RUNNER_CONN_PROOF_SERVER=http://…`).
@MainActor
final class ThreadDetailsUITests: XCTestCase {
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

    private func element(_ id: String) -> XCUIElement {
        app.descendants(matching: .any)[id]
    }

    private func commands() throws -> [[String: Any]] {
        let data = try Data(contentsOf: XCTUnwrap(URL(string: server + "/commands")))
        return try XCTUnwrap(JSONSerialization.jsonObject(with: data) as? [[String: Any]])
    }

    private func shot(_ name: String) {
        let attachment = XCTAttachment(screenshot: app.screenshot())
        attachment.name = name
        attachment.lifetime = .keepAlways
        add(attachment)
    }

    private func openDetails(of thread: String) {
        app.launch()
        let row = element("inbox.thread.\(thread)")
        XCTAssertTrue(row.waitForExistence(timeout: 30), "inbox row \(thread)")
        row.tap()
        XCTAssertTrue(element("thread.composer").waitForExistence(timeout: 10), "composer")
        let more = element("thread.moreButton")
        XCTAssertTrue(more.waitForExistence(timeout: 5), "··· button")
        more.tap()
        XCTAssertTrue(app.navigationBars["Thread details"].waitForExistence(timeout: 5), "details sheet")
        XCTAssertTrue(element("thread.details.machine").waitForExistence(timeout: 10), "machine row")
    }

    /// Pulls the sheet from the medium detent to the large one by its title bar.
    private func expandSheet() {
        let bar = app.navigationBars["Thread details"]
        let start = bar.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.5))
        start.press(forDuration: 0.05, thenDragTo: start.withOffset(CGVector(dx: 0, dy: -500)))
        Thread.sleep(forTimeInterval: 0.8)
    }

    private func scrollTo(_ id: String) -> XCUIElement {
        let target = element(id)
        let list = app.scrollViews.firstMatch
        for _ in 0..<6 where !(target.exists && target.isHittable) {
            list.swipeUp(velocity: .slow)
        }
        return target
    }

    // MARK: - Tests

    func testDetailsSheetSectionsPullRequestsAndPreviousAgents() throws {
        openDetails(of: "qdetails")
        shot("details-medium")

        // Machine and project, then the actions.
        XCTAssertTrue(element("thread.details.machine").label.contains("apps"), "project on the machine row")
        XCTAssertTrue(element("thread.details.outline").exists, "Thread outline row")
        XCTAssertTrue(element("thread.details.copyLink").exists, "Copy thread link row")
        XCTAssertTrue(element("thread.details.copyPath").exists, "Copy folder path row")
        XCTAssertTrue(element("thread.details.copyPath").label.contains("~/apps/conn"), "folder label")

        // A copy row says "Copied" for a moment.
        element("thread.details.copyLink").tap()
        XCTAssertTrue(element("thread.details.copyLink").label.contains("Copied"), "copied feedback")

        // Two PRs, latest first, then "Show 2 more".
        XCTAssertTrue(element("thread.details.pr.1931").exists, "newest PR")
        XCTAssertTrue(element("thread.details.pr.1936").exists, "second PR")
        XCTAssertFalse(element("thread.details.pr.1934").exists, "third PR waits behind Show more")
        let toggle = element("thread.details.prs.toggle")
        XCTAssertEqual(toggle.label, "Show 2 more")

        expandSheet()
        shot("details-large")
        toggle.tap()
        XCTAssertTrue(element("thread.details.pr.1934").waitForExistence(timeout: 3), "expanded PRs")
        XCTAssertTrue(element("thread.details.pr.1929").exists, "oldest PR")
        XCTAssertTrue(element("thread.details.pr.1934").label.contains("Draft"), "draft state")
        XCTAssertEqual(element("thread.details.prs.toggle").label, "Show less")
        shot("details-prs-expanded")

        // Git: the branch and the working tree's changes.
        XCTAssertTrue(scrollTo("thread.details.branch").exists, "branch row")
        XCTAssertTrue(element("thread.details.branch").label.contains("main"))
        XCTAssertTrue(element("thread.details.changes").label.contains("+764"), "changes count")

        // Subagents: two running with model labels, the rest behind "Previous agents".
        XCTAssertTrue(app.staticTexts["Subagents · 2 running"].exists, "subagents heading")
        let running = scrollTo("thread.details.agent.qchild0")
        XCTAssertTrue(running.exists, "running subagent")
        XCTAssertTrue(running.label.contains("Opus 5.5 · high"), "model label: \(running.label)")
        let previous = scrollTo("thread.details.previousAgents")
        XCTAssertTrue(previous.label.contains("9"), "previous count: \(previous.label)")
        previous.tap()
        XCTAssertTrue(app.navigationBars["Previous agents"].waitForExistence(timeout: 5), "pushed list")
        XCTAssertTrue(element("thread.details.agent.qchild5").waitForExistence(timeout: 3), "failed agent")
        XCTAssertTrue(element("thread.details.agent.qchild5").label.contains("Failed"))
        shot("details-previous-agents")
        app.navigationBars["Previous agents"].buttons.element(boundBy: 0).tap()
        XCTAssertTrue(app.navigationBars["Thread details"].waitForExistence(timeout: 5), "back to the panel")

        element("thread.details.close").tap()
        XCTAssertTrue(app.navigationBars["Thread details"].waitForNonExistence(timeout: 5), "sheet closed")
        XCTAssertTrue(element("thread.composer").exists, "back on the thread")
    }

    func testInitializeGitInAPlainFolder() throws {
        openDetails(of: "qplain")
        let initGit = element("thread.details.initGit")
        XCTAssertTrue(initGit.waitForExistence(timeout: 10), "Initialize Git row")
        XCTAssertTrue(initGit.label.contains("notes is not a Git repository yet"))
        XCTAssertFalse(element("thread.details.section.Pull requests").exists, "no PR section")
        shot("details-no-git")
        initGit.tap()
        let deadline = Date().addingTimeInterval(5)
        while try commands().contains(where: { $0["type"] as? String == "vcs.init" }) == false, Date() < deadline {
            Thread.sleep(forTimeInterval: 0.2)
        }
        let sent = try commands().first(where: { $0["type"] as? String == "vcs.init" })
        XCTAssertEqual(sent?["cwd"] as? String, "/Users/nick/notes", "vcs.init for the thread's folder")
        XCTAssertTrue(element("thread.details.branch").waitForExistence(timeout: 5), "branch after init")
    }

    func testOutlineRowOpensTheOutline() throws {
        openDetails(of: "qdetails")
        element("thread.details.outline").tap()
        XCTAssertTrue(app.navigationBars["Thread outline"].waitForExistence(timeout: 5), "outline sheet")
    }
}
