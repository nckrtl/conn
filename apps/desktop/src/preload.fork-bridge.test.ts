// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import { expect, it } from "vite-plus/test";

const preload = NodeFS.readFileSync(NodePath.join(import.meta.dirname, "preload.ts"), "utf8");

it("exposes Conn desktopBridge keys the renderer still calls", () => {
  for (const key of [
    "apiSend",
    "orbitGatewaySend",
    "databaseRun",
    "vaultwardenSetup",
    "vaultLogins",
    "vaultFill",
    "vaultDatabases",
    "mcpConnect",
    "mcpRequest",
    "mcpDisconnect",
    "onMcpEvent",
    "openWorkspaceWindow",
    "reportWorkspace",
    "windowContext",
    "getLocalThemes",
    "onLocalThemesChanged",
  ]) {
    expect(preload).toContain(`${key}:`);
  }
  expect(preload).toContain("--t3code-window=additional");
});
