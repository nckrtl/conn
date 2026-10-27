import * as Cause from "effect/Cause";
import { describe, expect, it } from "vite-plus/test";

import { formatEnvironmentQueryError } from "./query";

describe("formatEnvironmentQueryError", () => {
  it("says the server is too old when it lacks the method", () => {
    expect(
      formatEnvironmentQueryError(Cause.die("Unknown request tag: annotations.subscribe")),
    ).toBe("This environment's Conn server is too old for this. Update it to use it here.");
  });

  it("keeps an error's own message", () => {
    expect(formatEnvironmentQueryError(Cause.fail(new Error("Project not found.")))).toBe(
      "Project not found.",
    );
  });

  it("falls back for other defects", () => {
    expect(formatEnvironmentQueryError(Cause.die("boom"))).toBe("The environment request failed.");
  });
});
