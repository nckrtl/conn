import SwiftUI

/// One size for every piece of thread text, so prose, cards and footers stay in step (lab: `--thread-text`).
/// These are the standard text size's values. Polar's one-step-smaller setting scales them to about
/// 15 pt, 12.3 pt for code and timestamps, which is what the lab's 15 px default shows (Nick, 2026-11-25).
enum ThreadText {
    static let size: CGFloat = 17
    /// Code blocks and inline code read a step smaller than prose (lab `.m-code-body`).
    static let codeSize: CGFloat = 14
    /// Timestamps under messages sit a step below the thread text.
    static let metaSize: CGFloat = 14
}
