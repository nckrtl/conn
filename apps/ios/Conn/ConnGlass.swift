import SwiftUI

/// Conn's Liquid Glass: the system glass tinted with the screen colour, a little darker than the
/// stock glass. Every custom `glassEffect` uses it.
enum ConnGlass {
    static let tint = 0.35
    /// Sheets on the system glass take a darker layer over it.
    static let sheetTint = 0.7
}

extension Glass {
    static func conn(_ theme: ConnTheme) -> Glass {
        .regular.tint(theme.background.opacity(ConnGlass.tint))
    }
}
