import * as NodeNet from "node:net";
import * as NodeTimersPromises from "node:timers/promises";

/**
 * Electron arguments for one dev launch. With the macOS dev protocol client the launcher script
 * already supplies the app entry and `--t3code-dev-root`.
 */
export function buildElectronLaunchArgs({ remoteDebuggingPort, devProtocolClient, desktopDir }) {
  const debugArgs = remoteDebuggingPort ? [`--remote-debugging-port=${remoteDebuggingPort}`] : [];
  return devProtocolClient
    ? debugArgs
    : [...debugArgs, `--t3code-dev-root=${desktopDir}`, "dist-electron/main.cjs"];
}

/** The debug port as a number, or null when it is unset, invalid, or 0 (Chromium picks one). */
export function parseDebugPort(value) {
  const port = Number.parseInt(value ?? "", 10);
  return Number.isInteger(port) && port > 0 && port < 65_536 ? port : null;
}

/** True when this process can bind `host:port`, which is the check Chromium's DevTools server fails. */
export function isTcpPortFree({ host, port }) {
  return new Promise((resolve) => {
    const server = NodeNet.createServer();
    server.once("error", () => resolve(false));
    server.listen({ host, port, exclusive: true }, () => {
      server.close(() => resolve(true));
    });
  });
}

/**
 * Waits until the debug port can be bound. A relaunch starts while the previous Electron is still
 * shutting down (tsdown kills the old dev-electron and starts a new one on every rebuild), and
 * Chromium then silently runs without a DevTools server for good. Returns false on timeout.
 */
export async function waitForPortFree({
  host = "127.0.0.1",
  port,
  timeoutMs = 10_000,
  intervalMs = 100,
  isPortFree = isTcpPortFree,
  sleep = (ms) => NodeTimersPromises.setTimeout(ms),
  now = Date.now,
}) {
  const deadline = now() + timeoutMs;
  while (!(await isPortFree({ host, port }))) {
    if (now() >= deadline) {
      return false;
    }
    await sleep(intervalMs);
  }
  return true;
}

/** The parent that started this script is gone once the parent pid changes (orphans move to pid 1). */
export function isParentGone(initialParentPid, currentParentPid) {
  return currentParentPid !== initialParentPid;
}
