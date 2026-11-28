import XCTest
@testable import Conn

final class InboxAttentionTests: XCTestCase {
    /// The roll-up reads every machine's session, so a machine that drops or reconnects must
    /// recompute it even when no shell publishes.
    @MainActor
    func testSessionChangeRecomputesAttentionWithoutAShellPublish() async {
        let publications = InboxPublications()
        let store = CoreStore(scope: "test-" + UUID().uuidString, deferOrbit: true, publications: publications)
        let committed = expectation(description: "attention recomputed")
        publications.onCommit = { committed.fulfill() }
        store.handleState(FfiSessionState(revision: 1, connectionId: 1, phase: .idle(message: nil),
                                          serverUrl: nil, environmentId: "b", offlineReady: false,
                                          showsOffline: false, hasConnected: true, identityEpoch: 1,
                                          failedTries: 0, startRetries: 0, inGrace: false))
        await fulfillment(of: [committed], timeout: 5)
    }
}
