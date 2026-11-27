import UniformTypeIdentifiers
import XCTest
@testable import Conn

final class ComposerIdentityTests: XCTestCase {
    @MainActor
    func testAutomaticIdentityChangeDiscardsOutstandingPicker() throws {
        let store = CoreStore(scope: "test-" + UUID().uuidString, deferOrbit: true)
        var session = FfiSessionState(revision: 1, connectionId: 1, phase: .idle(message: nil),
                                      serverUrl: nil, environmentId: "first", offlineReady: false,
                                      showsOffline: false, hasConnected: true, identityEpoch: 1,
                                      failedTries: 0, startRetries: 0, inGrace: false)
        store.handleState(session)
        let key = ComposerDraftKey.new(project: nil, prompt: "")
        let draft = store.composerDraft(key, initialText: "Private draft")
        let source = FileManager.default.temporaryDirectory.appending(path: UUID().uuidString)
        try Data("fixture".utf8).write(to: source)
        defer { try? FileManager.default.removeItem(at: source) }
        let limits = FfiComposerLimits(images: false, maxFileBytes: 1024)
        func pickedFile() throws -> ComposerFile {
            try ComposerFile(copying: source, name: "selected.txt", type: .plainText, limits: limits)
        }
        try draft.append(pickedFile())
        let staged = try XCTUnwrap(draft.files.first?.url)
        let finishPicking = draft.append

        session.revision += 1
        session.connectionId += 1
        session.environmentId = "second"
        session.identityEpoch += 1
        store.handleState(session)

        XCTAssertTrue(draft.text.isEmpty)
        XCTAssertFalse(FileManager.default.fileExists(atPath: staged.path))
        XCTAssertThrowsError(try finishPicking(pickedFile())) { error in
            XCTAssertTrue(error is CancellationError)
        }
        XCTAssertTrue(draft.files.isEmpty)
        let fresh = store.composerDraft(key)
        XCTAssertFalse(fresh === draft)
        XCTAssertFalse(fresh.hasContent)
    }
}
