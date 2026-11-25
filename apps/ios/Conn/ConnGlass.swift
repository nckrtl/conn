import SwiftUI

/// Conn's Liquid Glass: the system glass tinted with the screen colour, darker than the stock
/// glass so controls read like the agents sheet. Every custom `glassEffect` uses it.
enum ConnGlass {
    static let tint = 0.7
}

extension Glass {
    static func conn(_ theme: ConnTheme) -> Glass {
        .regular.tint(theme.background.opacity(ConnGlass.tint))
    }
}
