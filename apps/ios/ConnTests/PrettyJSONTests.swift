@testable import Conn
import XCTest

final class PrettyJSONTests: XCTestCase {
    func testNestedJSONStringsAreDecodedInPlace() throws {
        let raw = #"{"content":"{\"earlierPosition\":1340,\"items\":[1,2]}","isError":false}"#
        let pretty = try XCTUnwrap(PrettyJSON.format(raw))
        XCTAssertFalse(pretty.contains(#"\""#), "no escaped quotes remain")
        XCTAssertTrue(pretty.contains(#""earlierPosition" : 1340"#))
        XCTAssertTrue(pretty.contains("\n  \"content\" : {"), "two-space indents")
    }

    func testTextThatIsNotJSONStaysAsItIs() {
        XCTAssertNil(PrettyJSON.format("Wrote screenshot to /tmp/a.png"))
        XCTAssertNil(PrettyJSON.format("{not json"))
    }

    func testPlainStringsInsideJSONAreKept() throws {
        let pretty = try XCTUnwrap(PrettyJSON.format(#"{"note":"{ just braces"}"#))
        XCTAssertTrue(pretty.contains(#""note" : "{ just braces""#))
    }
}
