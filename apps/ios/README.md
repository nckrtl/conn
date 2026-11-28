# Conn iPhone app

`apps/ios` is the native SwiftUI app. It builds only in nick-vm; the VM rules in
[AGENTS.md](../../AGENTS.md), "Build in nick-vm" (own checkout, own simulator, the GUI lock),
apply too. Run from the repo root:

1. `apps/ios/scripts/ios-bindings.sh` builds the host `conn-ffi` library and generates the
   Swift bindings, C header and modulemap into `apps/ios/ConnCore/Generated/`.
2. `apps/ios/scripts/build-core.sh` builds `conn-ffi` (release) for `aarch64-apple-ios` and
   `aarch64-apple-ios-sim`, installing missing Rust targets, and packages
   `apps/ios/build/ConnCore.xcframework`. It needs step 1 first, and `rustup` and `xcodebuild`.
3. Build `apps/ios/Conn.xcodeproj` with the `Conn` scheme (`xcodebuild -project
   apps/ios/Conn.xcodeproj -scheme Conn`), passing your simulator's UDID as the destination.
   The scheme's tests are `ConnTests` and `ConnUITests`.

`Conn.xcodeproj` is generated from `apps/ios/project.yml` with XcodeGen
(`xcodegen generate --spec apps/ios/project.yml` from the repo root);
commit both. The project also needs the `DesignKit` package at `../../../design-kit/DesignKit`
relative to `apps/ios`.

The app's custom symbols (`Conn/ConnSymbols.xcassets`, `Conn/ConnSymbolNames.swift`) are hand-owned.
To add one, add its `.symbolset` and list its SF name in `ConnSymbolNames.swift`.

The feature inventory, ported from the legacy mobile app: [docs/features.md](docs/features.md).
