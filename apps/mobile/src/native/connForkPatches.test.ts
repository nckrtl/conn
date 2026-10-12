import * as NodeFS from "node:fs";
import * as NodeModule from "node:module";
import * as NodePath from "node:path";

import { describe, expect, it } from "vite-plus/test";

// Conn fork guard: an upstream merge must not silently drop the fork's
// react-native-screens patch or the screens that rely on it. See FORK.md,
// "Vendored dependency patches".
const mobileRoot = NodePath.join(import.meta.dirname, "../..");
const read = (path: string) => NodeFS.readFileSync(NodePath.join(mobileRoot, path), "utf8");

describe("Conn react-native-screens patch", () => {
  it("installs the patched tarball built by scripts/build-conn-react-native-screens.ts", () => {
    const manifest = JSON.parse(read("package.json")) as {
      dependencies: Record<string, string>;
    };
    expect(manifest.dependencies["react-native-screens"]).toMatch(
      /^file:deps\/react-native-screens-.+-conn\.tgz$/,
    );
  });

  it("ships the search field accessory in the installed package", () => {
    const require = NodeModule.createRequire(NodePath.join(mobileRoot, "package.json"));
    const packageDir = NodePath.dirname(require.resolve("react-native-screens/package.json"));
    const coordinator = NodeFS.readFileSync(
      NodePath.join(packageDir, "ios/header/RNSHeaderCoordinator.mm"),
      "utf8",
    );
    const spec = NodeFS.readFileSync(
      NodePath.join(packageDir, "src/fabric/header/HeaderItemIOSNativeComponent.ts"),
      "utf8",
    );
    expect(coordinator).toContain("applySearchFieldAccessoryForItem");
    expect(spec).toContain("searchFieldAccessory");
  });

  it("keeps the home filter inside the bottom search field", () => {
    expect(read("src/features/home/HomeHeader.tsx")).toContain("filterInsideSearch: true");
    expect(read("src/native/V5StackHeader.ios.tsx")).toContain("searchFieldAccessory:");
  });
});
