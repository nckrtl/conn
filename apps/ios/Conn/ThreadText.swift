import SwiftUI

/// One size for every piece of thread text, so prose, cards and footers stay in step (lab: `--thread-text`).
/// These are the standard text size's values. Polar's one-step-smaller setting scales them to 14 pt
/// and 11.4 pt for code, which is what the lab's 14 px and 11.5 px defaults show.
enum ThreadText {
    static let size: CGFloat = 16
    /// Code blocks and inline code read a step smaller than prose (lab `.m-code-body`).
    static let codeSize: CGFloat = 13
    /// Timestamps under messages sit a step below the thread text.
    static let metaSize: CGFloat = 13
}
