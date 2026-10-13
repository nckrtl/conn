import ExpoModulesCore
import UIKit

/// Conn: installs the SF Symbol override before the first view loads.
public final class ConnSymbolsAppDelegateSubscriber: ExpoAppDelegateSubscriber {
  public func application(
    _ application: UIApplication,
    willFinishLaunchingWithOptions launchOptions: [UIApplication.LaunchOptionsKey: Any]?
  ) -> Bool {
    ConnSymbols.install()
    return true
  }
}

/// Returns Conn's Phosphor custom symbols (ConnSymbols.xcassets, built by
/// scripts/build-conn-symbols.ts) for the SF Symbol names in `connSymbolNames`.
/// Swapping `UIImage`'s `systemImageNamed` methods covers every caller at once:
/// expo-symbols views, native toolbar and tab bar items, and menus. Custom symbols
/// keep symbol sizing, weight scale and tint. Other names stay SF Symbols.
enum ConnSymbols {
  private final class BundleMarker {}

  static let bundle: Bundle? = {
    for candidate in [Bundle.main, Bundle(for: BundleMarker.self)] {
      if let url = candidate.url(forResource: "ConnSymbols", withExtension: "bundle") {
        return Bundle(url: url)
      }
    }
    return nil
  }()

  private static var installed = false

  static func install() {
    guard !installed, bundle != nil else { return }
    installed = true
    swap("systemImageNamed:", "conn_systemImageNamed:")
    swap("systemImageNamed:withConfiguration:", "conn_systemImageNamed:withConfiguration:")
    swap(
      "systemImageNamed:compatibleWithTraitCollection:",
      "conn_systemImageNamed:compatibleWithTraitCollection:"
    )
  }

  static func image(named name: String, configuration: UIImage.Configuration?) -> UIImage? {
    guard connSymbolNames.contains(name), let bundle else { return nil }
    return UIImage(named: name, in: bundle, with: configuration)
  }

  static func image(named name: String, traitCollection: UITraitCollection?) -> UIImage? {
    guard connSymbolNames.contains(name), let bundle else { return nil }
    return UIImage(named: name, in: bundle, compatibleWith: traitCollection)
  }

  private static func swap(_ original: String, _ replacement: String) {
    guard
      let originalMethod = class_getClassMethod(UIImage.self, NSSelectorFromString(original)),
      let replacementMethod = class_getClassMethod(UIImage.self, NSSelectorFromString(replacement))
    else { return }
    method_exchangeImplementations(originalMethod, replacementMethod)
  }
}

extension UIImage {
  // After `ConnSymbols.install()` these hold the original implementations, so each
  // falls back to the system symbol by calling itself.
  @objc(conn_systemImageNamed:)
  dynamic class func conn_systemImageNamed(_ name: String) -> UIImage? {
    ConnSymbols.image(named: name, configuration: nil) ?? conn_systemImageNamed(name)
  }

  @objc(conn_systemImageNamed:withConfiguration:)
  dynamic class func conn_systemImageNamed(
    _ name: String,
    withConfiguration configuration: UIImage.Configuration?
  ) -> UIImage? {
    ConnSymbols.image(named: name, configuration: configuration)
      ?? conn_systemImageNamed(name, withConfiguration: configuration)
  }

  @objc(conn_systemImageNamed:compatibleWithTraitCollection:)
  dynamic class func conn_systemImageNamed(
    _ name: String,
    compatibleWithTraitCollection traitCollection: UITraitCollection?
  ) -> UIImage? {
    ConnSymbols.image(named: name, traitCollection: traitCollection)
      ?? conn_systemImageNamed(name, compatibleWithTraitCollection: traitCollection)
  }
}
