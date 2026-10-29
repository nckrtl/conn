import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";

import { describe, expect, it } from "vite-plus/test";

// Conn fork guard: agents on any server drive the user's desktop tabs through the
// desktop tab relay. Upstream copy that says otherwise makes agents refuse. See
// FORK.md, "Desktop tab automation".
const read = (file: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    return yield* fs.readFileString(path.join(import.meta.dirname, file));
  }).pipe(Effect.provide(NodeServices.layer), Effect.runPromise);

describe("Conn desktop tab copy", () => {
  it.each(["non-server", "cannot reach", "Only `runtime:'server'`", "local desktop app"])(
    "never tells agents desktop tabs are out of reach (%s)",
    async (phrase) => {
      const previewCopy = await Promise.all([
        read("preview/tools.ts"),
        read("previewControls/tools.ts"),
      ]);
      for (const source of previewCopy) expect(source).not.toContain(phrase);
    },
  );

  it("tells agents the preview tools drive desktop tabs", async () => {
    expect(await read("previewControls/tools.ts")).toContain(
      "`preview_*` tools drive both kinds from here",
    );
  });
});
