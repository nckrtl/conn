import type { ScopedThreadRef } from "@t3tools/contracts";

/** Desktop guests keep their identity across reconnects; transport generations are separate. */
export function previewRuntimeTabId(threadRef: ScopedThreadRef, tabId: string): string {
  return JSON.stringify([threadRef.environmentId, threadRef.threadId, tabId]);
}
