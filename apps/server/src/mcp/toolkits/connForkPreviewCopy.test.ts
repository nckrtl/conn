// @effect-diagnostics nodeBuiltinImport:off - Reads the tool copy sources as plain files.
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

import { describe, expect, it } from "vite-plus/test";

// Conn fork guard: agents on any server drive the user's desktop tabs through the
// desktop tab relay. Upstream copy that says otherwise makes agents refuse. See
// FORK.md, "Desktop tab automation".
const read = (path: string) =>
  NodeFS.readFileSync(NodePath.join(import.meta.dirname, path), "utf8");
const previewCopy = [read("preview/tools.ts"), read("previewControls/tools.ts")];

describe("Conn desktop tab copy", () => {
  it.each(["non-server", "cannot reach", "Only `runtime:'server'`", "local desktop app"])(
    "never tells agents desktop tabs are out of reach (%s)",
    (phrase) => {
      for (const source of previewCopy) expect(source).not.toContain(phrase);
    },
  );

  it("tells agents the preview tools drive desktop tabs", () => {
    expect(read("previewControls/tools.ts")).toContain(
      "`preview_*` tools drive both kinds from here",
    );
  });
});
