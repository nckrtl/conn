import SwiftUI

/// One size for every piece of thread text, so prose, cards and footers stay in step (lab: `--thread-text`).
/// These are the standard text size's values. Polar's one-step-smaller setting scales them to about
/// 14 pt, 12.3 pt for code, which is what the lab's 14 px default shows (Nick, 2026-11-26: 15 → 14).
enum ThreadText {
    static let size: CGFloat = 16
    /// Code blocks and inline code read a step smaller than prose (lab `.m-code-body`).
    static let codeSize: CGFloat = 14
    /// Timestamps under messages sit a step below the thread text.
    static let metaSize: CGFloat = 14
}
