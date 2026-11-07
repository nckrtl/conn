#!/usr/bin/env node
// @effect-diagnostics nodeBuiltinImport:off globalConsole:off
import * as NodeChildProcess from "node:child_process";

import { vitePlusCommand } from "./check-changed-command.ts";
import { desktopTypecheckVpArgs } from "./desktop-typecheck.ts";

const [command, args] = vitePlusCommand([...desktopTypecheckVpArgs]);
const result = NodeChildProcess.spawnSync(command, args, { stdio: "inherit" });
if (result.error !== undefined) {
  console.error(result.error);
  process.exit(1);
}
process.exit(result.status === null ? 1 : result.status);
