import { orbitThreadsAvailableNow } from "./environmentProvider";

export function orbitThreadStartBlockedReason(): string | null {
  if (window.desktopBridge?.orbitGatewaySend === undefined) {
    return "Threads in an Orbit Project start only in the Conn desktop app. Open this Project there.";
  }
  if (!orbitThreadsAvailableNow()) {
    return "Choose Orbit under Settings › Environments › Environments from, then try again.";
  }
  return null;
}
