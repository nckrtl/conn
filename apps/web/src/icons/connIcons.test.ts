import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

import { describe, expect, it } from "vite-plus/test";

// Conn fork guard: an upstream merge must not silently drop the wiring that
// sends Lucide imports to Conn's icon module or the thread's Phosphor scope.
// See FORK.md, "Icons".
const webRoot = NodePath.join(import.meta.dirname, "../..");
const read = (path: string) => NodeFS.readFileSync(NodePath.join(webRoot, path), "utf8");

describe("Conn icon module", () => {
  it("maps lucide and lucide-react to src/icons in Vite and TypeScript", () => {
    const vite = read("vite.config.ts");
    expect(vite).toContain("find: /^lucide-react$/");
    expect(vite).toContain('"./src/icons/lucide-react.ts"');
    expect(vite).toContain("find: /^lucide$/");
    expect(vite).toContain('"./src/icons/lucide.ts"');
    const tsconfig = read("tsconfig.json");
    expect(tsconfig).toContain('"lucide-react": ["./src/icons/lucide-react.ts"]');
    expect(tsconfig).toContain('"lucide": ["./src/icons/lucide.ts"]');
  });

  it("draws Phosphor only inside the thread timeline", () => {
    const chatView = read("src/components/ChatView.tsx");
    const scope = chatView.indexOf("<ConnIconScope>");
    expect(scope).toBeGreaterThan(-1);
    expect(chatView.indexOf("<MessagesTimeline", scope)).toBeGreaterThan(scope);
  });

  it("keeps workspace icons on the original Lucide package", () => {
    expect(read("src/components/sidebar/workspaceVisuals.tsx")).toContain(
      'from "lucide-react-original"',
    );
  });
});
