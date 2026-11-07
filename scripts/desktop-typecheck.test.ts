import { expect } from "vite-plus/test";
import { describe, it } from "@effect/vitest";

import {
  DESKTOP_TYPECHECK_PACKAGE,
  desktopTypecheckVpArgs,
  withDesktopTypecheck,
} from "./desktop-typecheck.ts";

describe("desktop typecheck gate", () => {
  it("always includes the desktop Vite typecheck package", () => {
    expect(withDesktopTypecheck([])).toEqual([DESKTOP_TYPECHECK_PACKAGE]);
    expect(withDesktopTypecheck(["@t3tools/web"])).toEqual([
      "@t3tools/web",
      DESKTOP_TYPECHECK_PACKAGE,
    ]);
    expect(withDesktopTypecheck([DESKTOP_TYPECHECK_PACKAGE, "@t3tools/web"])).toEqual([
      DESKTOP_TYPECHECK_PACKAGE,
      "@t3tools/web",
    ]);
  });

  it("invokes the existing desktop Vite typecheck task", () => {
    expect([...desktopTypecheckVpArgs]).toEqual([
      "run",
      "--filter",
      "@t3tools/desktop",
      "typecheck",
    ]);
  });
});
