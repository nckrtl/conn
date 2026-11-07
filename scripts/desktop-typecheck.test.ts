import { expect } from "vite-plus/test";
import { describe, it } from "@effect/vitest";

import { vitePlusCommand } from "./check-changed-command.ts";
import {
  DESKTOP_TYPECHECK_LABEL,
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
      "--no-cache",
      "--filter",
      "@t3tools/desktop",
      "typecheck",
    ]);
    expect(DESKTOP_TYPECHECK_LABEL).toBe("vp run --no-cache --filter @t3tools/desktop typecheck");
    const [, args] = vitePlusCommand([...desktopTypecheckVpArgs]);
    expect(args.slice(-5)).toEqual([
      "run",
      "--no-cache",
      "--filter",
      "@t3tools/desktop",
      "typecheck",
    ]);
  });
});
