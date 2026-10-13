import { describe, expect, it } from "vite-plus/test";

import tsconfig from "../../tsconfig.json?raw";
import viteConfig from "../../vite.config.ts?raw";
import chatView from "../components/ChatView.tsx?raw";
import workspaceVisuals from "../components/sidebar/workspaceVisuals.tsx?raw";

// Conn fork guard: an upstream merge must not silently drop the wiring that
// sends Lucide imports to Conn's icon module or the thread's Phosphor scope.
// See FORK.md, "Icons".
describe("Conn icon module", () => {
  it("maps lucide and lucide-react to src/icons in Vite and TypeScript", () => {
    expect(viteConfig).toContain("find: /^lucide-react$/");
    expect(viteConfig).toContain('"./src/icons/lucide-react.ts"');
    expect(viteConfig).toContain("find: /^lucide$/");
    expect(viteConfig).toContain('"./src/icons/lucide.ts"');
    expect(tsconfig).toContain('"lucide-react": ["./src/icons/lucide-react.ts"]');
    expect(tsconfig).toContain('"lucide": ["./src/icons/lucide.ts"]');
  });

  it("draws Phosphor only inside the thread timeline", () => {
    const scope = chatView.indexOf("<ConnIconScope>");
    expect(scope).toBeGreaterThan(-1);
    expect(chatView.indexOf("<MessagesTimeline", scope)).toBeGreaterThan(scope);
  });

  it("keeps workspace icons on the original Lucide package", () => {
    expect(workspaceVisuals).toContain('from "lucide-react-original"');
  });
});
