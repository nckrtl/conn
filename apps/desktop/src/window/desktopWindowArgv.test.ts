import { expect, it } from "vite-plus/test";

import { parseDesktopWindowArgv } from "./desktopWindowArgv.ts";

it("treats a window without extra-window argv as the main window", () => {
  expect(parseDesktopWindowArgv(["electron", "."])).toEqual({
    additional: false,
    workspace: null,
  });
});

it("reads an extra window and its starting workspace from argv", () => {
  expect(
    parseDesktopWindowArgv([
      "electron",
      "--t3code-window=additional",
      `--t3code-window-workspace=${encodeURIComponent("Alpha 2")}`,
    ]),
  ).toEqual({ additional: true, workspace: "Alpha 2" });
});

it("drops a workspace whose argv encoding is invalid", () => {
  expect(
    parseDesktopWindowArgv([
      "electron",
      "--t3code-window=additional",
      "--t3code-window-workspace=%E0%A4%A",
    ]),
  ).toEqual({ additional: true, workspace: null });
});
