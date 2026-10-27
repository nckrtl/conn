import type { DictationSettings } from "./dictation";
import { postDictation, recordDictationTiming } from "./post-dictation";

export type HostDictationAction = "start" | "stop";
export type HostSessionAction = "start" | "stop" | "cancel";

/**
 * An embedding app defines this on `window.__ANNOTATOR_HOST__` to start and stop
 * desktop dictation outside the page, where the page's Content-Security-Policy
 * does not apply. The page passes only the action; the host decides where the
 * request goes.
 */
export interface AnnotatorHost {
  /** Resolve `true` when dictation started or stopped, `false` when it did not. */
  dictation(action: HostDictationAction, options: { signal: AbortSignal }): Promise<boolean>;
  /**
   * Dictation keyed by the annotation's session id: the host keeps the transcript instead of
   * pasting it, and a stop resolves with `{ text }` once it is final. `false` means it failed.
   */
  dictationSession?(
    action: HostSessionAction,
    session: string,
    options: { signal: AbortSignal },
  ): Promise<{ text?: string } | boolean>;
}

declare global {
  interface Window {
    __ANNOTATOR_HOST__?: AnnotatorHost;
  }
}

export function hostDictationAvailable(): boolean {
  return (
    typeof window !== "undefined" && typeof window.__ANNOTATOR_HOST__?.dictation === "function"
  );
}

/** Host dictation that keeps each annotation's transcript by session id. */
export function usesHostSessions(settings?: DictationSettings | null): boolean {
  return (
    settings?.provider === "host" &&
    typeof window !== "undefined" &&
    typeof window.__ANNOTATOR_HOST__?.dictationSession === "function"
  );
}

/** Settle with the promise, or reject with the abort reason when the signal fires first. */
function untilAborted<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise((resolve, reject) => {
    const abort = () => reject(signal.reason);
    if (signal.aborted) return abort();
    signal.addEventListener("abort", abort, { once: true });
    promise.then(resolve, reject).finally(() => signal.removeEventListener("abort", abort));
  });
}

async function callHost(action: HostDictationAction, signal: AbortSignal): Promise<void> {
  const phase = action === "start" ? "dictate" : "dictate-stop";
  const start = performance.now();
  try {
    const host = window.__ANNOTATOR_HOST__;
    if (typeof host?.dictation !== "function") {
      throw new Error("The host has no dictation function.");
    }
    const done = await untilAborted(
      new Promise<boolean>((resolve) => resolve(host.dictation(action, { signal }))),
      signal,
    );
    if (done !== true) {
      throw new Error(
        action === "start"
          ? "The host did not start dictation."
          : "The host did not stop dictation.",
      );
    }
  } finally {
    recordDictationTiming(`annotate:${phase}-request`, start);
  }
}

/**
 * Ask the desktop dictation app to start or stop, through the host or over HTTP.
 * Start errors carry the reason; stop errors are complete messages.
 */
export async function triggerDictation(
  settings: DictationSettings,
  action: HostDictationAction,
  signal: AbortSignal,
): Promise<void> {
  if (settings.provider === "host") {
    try {
      await callHost(action, signal);
    } catch (cause) {
      if (signal.aborted || action === "start") throw cause;
      const reason = cause instanceof Error ? cause.message : "";
      throw new Error(
        reason ? `Could not stop dictation: ${reason}` : "Could not stop dictation.",
        {
          cause,
        },
      );
    }
    return;
  }
  if (action === "start") {
    const response = await postDictation(settings.postUrl!, signal, "dictate");
    if (!response.ok) throw new Error(`Dictation trigger failed (HTTP ${response.status}).`);
    return;
  }
  const response = await postDictation(settings.stopUrl!, signal, "dictate-stop");
  if (!response.ok) throw new Error(`Could not stop dictation (HTTP ${response.status}).`);
}

const SESSION_START_LIMIT_MS = 10_000;
// Operator waits up to 120 s for a transcript to become final.
const SESSION_STOP_LIMIT_MS = 130_000;
const stops = new Map<string, Promise<string>>();

async function callSession(
  action: HostSessionAction,
  session: string,
  signal: AbortSignal,
): Promise<string> {
  const host = window.__ANNOTATOR_HOST__;
  if (typeof host?.dictationSession !== "function") {
    throw new Error("The host has no dictation sessions.");
  }
  const result = await untilAborted(
    new Promise<{ text?: string } | boolean>((resolve) =>
      resolve(host.dictationSession!(action, session, { signal })),
    ),
    signal,
  );
  if (result === true) return "";
  if (typeof result === "object" && result !== null) {
    return typeof result.text === "string" ? result.text : "";
  }
  throw new Error(`The host did not ${action} dictation.`);
}

export async function startHostSession(session: string, signal: AbortSignal): Promise<void> {
  const start = performance.now();
  try {
    await callSession(
      "start",
      session,
      AbortSignal.any([signal, AbortSignal.timeout(SESSION_START_LIMIT_MS)]),
    );
  } finally {
    recordDictationTiming("annotate:dictate-request", start);
  }
}

/** The session's final transcript. Every caller for one session shares a single stop request. */
export function stopHostSession(session: string): Promise<string> {
  const pending = stops.get(session);
  if (pending) return pending;
  const stop = callSession("stop", session, AbortSignal.timeout(SESSION_STOP_LIMIT_MS));
  stops.set(session, stop);
  const forget = () => {
    stops.delete(session);
  };
  stop.then(forget, forget);
  return stop;
}

export function cancelHostSession(session: string): void {
  void callSession("cancel", session, AbortSignal.timeout(SESSION_START_LIMIT_MS)).catch(
    () => undefined,
  );
}
