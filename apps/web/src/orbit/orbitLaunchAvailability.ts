import { msg } from "gt-react";

import { m, type MessageResolver } from "../i18n/messages";
import { orbitThreadsAvailableNow } from "./environmentProvider";

export function orbitThreadStartBlockedReason(resolve: MessageResolver = m): string | null {
  const blocked = orbitThreadStartBlockedMessage();
  return blocked === null ? null : resolve(blocked);
}

export function orbitThreadStartBlockedMessage(): string | null {
  if (window.desktopBridge?.orbitGatewaySend === undefined) {
    return msg(
      "Threads in an Orbit Project start only in the Conn desktop app. Open this Project there.",
    );
  }
  if (!orbitThreadsAvailableNow()) {
    return msg("Choose Orbit under Settings › Environments › Environments from, then try again.");
  }
  return null;
}
