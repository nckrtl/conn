import XCTest
@testable import Conn

final class MarkdownCacheTests: XCTestCase {
    private let sample = """
    Intro paragraph with `code` and **bold**.

    - first item
    - second item
    1. numbered

    | A | B |
    | --- | --- |
    | 1 | 2 |
    after the table

    ```swift
    let x = 1
    ```
    > quoted
    ## Heading
    closing words
    """

    /// Streaming one character at a time gives the same blocks as parsing the whole text.
    @MainActor
    func testStreamedTextParsesLikeTheWholeText() {
        let id = "stream-" + UUID().uuidString
        var text = ""
        for character in sample {
            text.append(character)
            let streamed = MarkdownCache.blocks(text, id: id)
            let whole = parseBlocks(text).map(\.block)
            XCTAssertEqual(String(describing: streamed), String(describing: whole), "after \(text.count) characters")
        }
    }

    @MainActor
    func testAnEditedTextParsesAgain() {
        let id = "edit-" + UUID().uuidString
        _ = MarkdownCache.blocks("- one\n- two", id: id)
        let edited = MarkdownCache.blocks("Para\n\n- two", id: id)
        XCTAssertEqual(String(describing: edited), String(describing: parseBlocks("Para\n\n- two").map(\.block)))
    }
}
