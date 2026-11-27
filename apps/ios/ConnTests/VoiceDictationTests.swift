import SwiftUI
import UIKit
import XCTest
@testable import Conn

final class VoiceDictationTests: XCTestCase {
    // MARK: Engine selection

    func testDeviceEngineNeverNeedsSignIn() {
        var settings = VoiceSettings()
        XCTAssertEqual(OperatorVoice.route(for: settings), .device)
        settings.token = "t"
        settings.speech = "http://10.44.0.7:12331"
        XCTAssertEqual(OperatorVoice.route(for: settings), .device)
    }

    func testOperatorEngineUsesItsAddressAndTokenOrAsksToSignIn() {
        var settings = VoiceSettings()
        settings.engine = .operator
        XCTAssertEqual(OperatorVoice.route(for: settings), .needsSignIn)
        settings.token = "device-token"
        XCTAssertEqual(OperatorVoice.route(for: settings), .needsSignIn)
        settings.speech = "http://10.44.0.7:12331"
        XCTAssertEqual(OperatorVoice.route(for: settings), .operator(speech: "http://10.44.0.7:12331", token: "device-token"))
    }

    func testSettingsDecodeToleratesMissingAndUnknownFields() throws {
        let decoded = try JSONDecoder().decode(VoiceSettings.self, from: Data(#"{"engine":"bogus","token":"abc"}"#.utf8))
        XCTAssertEqual(decoded.engine, .device)
        XCTAssertEqual(decoded.token, "abc")
        XCTAssertEqual(decoded.server, "")
        let operatorSettings = try JSONDecoder().decode(VoiceSettings.self, from: Data(#"{"engine":"operator"}"#.utf8))
        XCTAssertEqual(operatorSettings.engine, .operator)
    }

    // MARK: Storage keys

    func testStorageKeysMatchTheStoredAccounts() {
        XCTAssertEqual(VoiceStorageKey.settings, "voice-transcription-v2")
        XCTAssertEqual(VoiceStorageKey.deviceKey, "voice-transcription-device-key")
    }

    func testSettingsRoundTripKeepsTheTokenInTheStoredJSON() throws {
        var settings = VoiceSettings()
        settings.engine = .operator
        settings.token = "secret"
        let copy = try JSONDecoder().decode(VoiceSettings.self, from: JSONEncoder().encode(settings))
        XCTAssertEqual(copy, settings)
    }

    // MARK: Operator requests

    func testServerAddressIsReadLikeTheOperatorApp() throws {
        XCTAssertEqual(OperatorVoice.origin(try OperatorVoice.serverURL("operator.test/")), "https://operator.test")
        XCTAssertEqual(OperatorVoice.origin(try OperatorVoice.serverURL("10.44.0.7:12332")), "http://10.44.0.7:12332")
        XCTAssertEqual(OperatorVoice.origin(try OperatorVoice.serverURL(" https://operator.test ")), "https://operator.test")
        XCTAssertThrowsError(try OperatorVoice.serverURL("")) { error in
            XCTAssertEqual((error as? VoiceError)?.message, "Enter the server address, such as https://operator.test.")
        }
        XCTAssertThrowsError(try OperatorVoice.serverURL("ftp://operator.test"))
    }

    func testSpeechBaseUsesTheGivenAddressOrTheHostOnTheOpenAIPort() throws {
        let server = try OperatorVoice.serverURL("operator.test")
        XCTAssertEqual(OperatorVoice.speechBase(server: server, openai: "http://10.44.0.7:12331///"), "http://10.44.0.7:12331")
        XCTAssertEqual(OperatorVoice.speechBase(server: server, openai: nil), "http://operator.test:12331")
        XCTAssertEqual(OperatorVoice.speechBase(server: server, openai: ""), "http://operator.test:12331")
    }

    func testSignInRequests() throws {
        let server = try OperatorVoice.serverURL("operator.test")
        let authorize = try OperatorVoice.authorizeRequest(server: server, deviceName: "Polar", deviceKey: "k")
        XCTAssertEqual(authorize.url?.absoluteString, "https://operator.test/api/devices/authorize")
        XCTAssertEqual(authorize.httpMethod, "POST")
        XCTAssertNil(authorize.value(forHTTPHeaderField: "Authorization"))
        let body = try XCTUnwrap(JSONSerialization.jsonObject(with: XCTUnwrap(authorize.httpBody)) as? [String: String])
        XCTAssertEqual(body, ["name": "Polar", "platform": "ios", "device_key": "k"])

        let token = try OperatorVoice.tokenRequest(server: server, deviceCode: "dev-code")
        XCTAssertEqual(token.url?.absoluteString, "https://operator.test/api/devices/token")
        XCTAssertEqual(
            try JSONSerialization.jsonObject(with: XCTUnwrap(token.httpBody)) as? [String: String], ["device_code": "dev-code"]
        )
    }

    func testSignOutRevokesWithTheBearerTokenAndSkipsWhenSignedOut() throws {
        let request = try XCTUnwrap(OperatorVoice.signOutRequest(server: "https://operator.test", token: "device-token"))
        XCTAssertEqual(request.url?.absoluteString, "https://operator.test/api/devices/sign-out")
        XCTAssertEqual(request.value(forHTTPHeaderField: "Authorization"), "Bearer device-token")
        XCTAssertNil(request.httpBody)
        XCTAssertNil(try OperatorVoice.signOutRequest(server: "", token: "device-token"))
        XCTAssertNil(try OperatorVoice.signOutRequest(server: "https://operator.test", token: ""))
    }

    func testTranscriptionUploadIsAnAuthorizedM4AMultipart() throws {
        let request = try OperatorVoice.transcriptionRequest(
            speech: "http://10.44.0.7:12331", token: "device-token", audio: Data("audio".utf8), filename: "dictation.m4a",
            boundary: "B"
        )
        XCTAssertEqual(request.url?.absoluteString, "http://10.44.0.7:12331/v1/audio/transcriptions")
        XCTAssertEqual(request.httpMethod, "POST")
        XCTAssertEqual(request.value(forHTTPHeaderField: "Authorization"), "Bearer device-token")
        XCTAssertEqual(request.value(forHTTPHeaderField: "Content-Type"), "multipart/form-data; boundary=B")
        let body = String(decoding: try XCTUnwrap(request.httpBody), as: UTF8.self)
        XCTAssertTrue(body.contains("name=\"response_format\"\r\n\r\njson"))
        XCTAssertTrue(body.contains("name=\"file\"; filename=\"dictation.m4a\"\r\nContent-Type: audio/m4a\r\n\r\naudio\r\n--B--"))
    }

    func testAnswersAndFailuresReadLikeTheExpoFlow() {
        XCTAssertEqual(OperatorVoice.transcriptionText(from: Data(#"{"text":" Hello there. "}"#.utf8)), "Hello there.")
        XCTAssertEqual(OperatorVoice.transcriptionText(from: Data("nope".utf8)), "")
        XCTAssertEqual(
            OperatorVoice.account(from: ["user": "Nick", "team": "Home", "device": ["name": "Polar"]]), "Nick · Home · Polar"
        )
        XCTAssertEqual(OperatorVoice.failureMessage(status: 401, data: Data()), OperatorVoice.signedOutMessage)
        XCTAssertEqual(OperatorVoice.failureMessage(status: 403, data: Data()), OperatorVoice.signedOutMessage)
        XCTAssertEqual(
            OperatorVoice.failureMessage(status: 500, data: Data(#"{"error":{"message":"model busy"}}"#.utf8)),
            "Operator: model busy"
        )
        XCTAssertEqual(OperatorVoice.failureMessage(status: 502, data: Data("<html>".utf8)), "The Operator server answered 502.")
    }

    // MARK: Insertion at the cursor

    func testInsertionAtTheCaretAddsOnlyTheSpacesItNeeds() {
        XCTAssertEqual(DictationInsertion.insert("hello", into: "", at: nil).text, "hello")
        XCTAssertEqual(DictationInsertion.insert(" hello ", into: "say", at: nil).text, "say hello")
        let middle = DictationInsertion.insert("big", into: "a cat", at: 2..<2)
        XCTAssertEqual(middle.text, "a big cat")
        XCTAssertEqual(middle.cursor, 5)
        XCTAssertEqual(DictationInsertion.insert("big", into: "ab", at: 1..<1).text, "a big b")
    }

    func testInsertionReplacesTheSelectionAndClampsStaleOffsets() {
        XCTAssertEqual(DictationInsertion.insert("dog", into: "a cat sat", at: 2..<5).text, "a dog sat")
        XCTAssertEqual(DictationInsertion.insert("x", into: "ab", at: 10..<20).text, "ab x")
        XCTAssertEqual(DictationInsertion.insert("  ", into: "ab", at: 1..<1).text, "ab")
    }

    // MARK: Composer metrics

    func testCollapsedInputIsExactlyOneControlTallAndExpandedKeepsTheLabInsets() {
        let natural: CGFloat = 17.9
        let line = ComposerInputMetrics.lineBox
        XCTAssertEqual(
            ComposerInputMetrics.topInset(expanded: false, natural: natural) + natural
                + ComposerInputMetrics.bottomInset(expanded: false, natural: natural), 44, accuracy: 0.001
        )
        // The line box with 14 above and 2 below, as the lab's `padding: 14px 12px 2px 15px`.
        XCTAssertEqual(
            ComposerInputMetrics.topInset(expanded: true, natural: natural) + natural
                + ComposerInputMetrics.bottomInset(expanded: true, natural: natural), 14 + line + 2, accuracy: 0.001
        )
        // Each extra line adds exactly one 22pt line pitch.
        XCTAssertEqual(natural + ComposerInputMetrics.lineSpacing(natural: natural), line, accuracy: 0.001)
    }

    func testCollapsedTextStartsTwoPointsAfterThePlusAndExpandedTextUnderThePlusGlyph() {
        XCTAssertEqual(ComposerInputMetrics.leadingInset(expanded: false, hasLeadingControl: true), 2)
        XCTAssertEqual(ComposerInputMetrics.leadingInset(expanded: false, hasLeadingControl: false), 12)
        XCTAssertEqual(ComposerInputMetrics.leadingInset(expanded: true, hasLeadingControl: true), 15)
    }

    func testTextWrapsOnlyWhenItWouldReachTheControls() {
        XCTAssertFalse(ComposerInputMetrics.wraps("Ask anything", in: 240))
        XCTAssertFalse(ComposerInputMetrics.wraps("Fix the build", in: 240))
        XCTAssertTrue(ComposerInputMetrics.wraps("Please look at the failing deploy check and fix it", in: 240))
        XCTAssertTrue(ComposerInputMetrics.wraps("Two\nlines", in: 240))
        // Before the geometry is known, one row.
        XCTAssertFalse(ComposerInputMetrics.wraps("Please look at the failing deploy check and fix it", in: 0))
    }

    func testSheetSurfaceRunsTwentyEightPointsBehindTheKeyboard() {
        // The box sits `bottomGutter` above the keyboard, so the surface reaches 28 past its top edge.
        XCTAssertEqual(ComposerSheet.bottomBleed, ComposerSheet.bottomGutter + 28)
        XCTAssertEqual(ComposerSheet.bottomBleed, 30)
        // The controls sit 4 pt clear: the screens' gutter plus the box's own 2 pt padding.
        XCTAssertEqual(ComposerSheet.bottomGutter + 2, 4)
    }

    func testKeyboardCurvesMapAndThePrivateCurveFallsBack() {
        func note(curve: Int?, duration: Double? = 0.3) -> Notification {
            var info: [AnyHashable: Any] = [:]
            if let curve { info[UIResponder.keyboardAnimationCurveUserInfoKey] = curve }
            if let duration { info[UIResponder.keyboardAnimationDurationUserInfoKey] = duration }
            return Notification(name: UIResponder.keyboardWillChangeFrameNotification, userInfo: info)
        }
        XCTAssertEqual(KeyboardMotion.animation(note(curve: 0)), .easeInOut(duration: 0.3))
        XCTAssertEqual(KeyboardMotion.animation(note(curve: 3)), .linear(duration: 0.3))
        XCTAssertEqual(KeyboardMotion.animation(note(curve: 7)), KeyboardMotion.privateCurve)
        XCTAssertEqual(KeyboardMotion.animation(note(curve: nil)), KeyboardMotion.privateCurve)
    }
}
