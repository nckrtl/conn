// @effect-diagnostics nodeBuiltinImport:off - Reads the sidebar source as a plain file.
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

import { describe, expect, it } from "vite-plus/test";

// Conn fork guard: the thread list sits in an inset shell card, and the workspace
// rail, not the sidebar footer, holds updates and utilities. Types and other tests
// still pass without either. See FORK.md, "Shell design".
const sidebar = NodeFS.readFileSync(
  NodePath.join(import.meta.dirname, "..", "Sidebar.tsx"),
  "utf8",
);

describe("Conn shell sidebar", () => {
  it("wraps the thread list in an inset shell card", () => {
    expect(sidebar).toMatch(/<div className="[^"]*\bshell-inner-panel\b[^"]*">\s*<SidebarContent/);
  });

  it("leaves updates and utilities to the workspace rail", () => {
    expect(sidebar).toContain("<SidebarChromeFooter utilities={false} />");
    expect(sidebar).not.toContain("<SidebarChromeFooter />");
  });
});
