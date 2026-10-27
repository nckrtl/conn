// The annotator overlay's `host` dictation: main POSTs to the tab's registered URL, so page CSP
// cannot block it and a page names only the action (and a session id). The request carries the
// page's origin, so the dictation app applies its own per-website approval (Operator's allowed
// websites). Session requests go to `/dictate/<action>` on the start URL's origin.
import { ANNOTATOR_DICTATION_CHANNEL } from "./GuestProtocol.ts";

export type DictationAction = "start" | "stop";
export type SessionAction = "start" | "stop" | "cancel";
/** `{ text }` answers a session stop: the session's final transcript. */
export type DictationResult = boolean | { readonly text: string };

export interface DictationUrls {
  readonly startUrl: string | null;
  readonly stopUrl: string | null;
}

const isAction = (value: unknown): value is DictationAction =>
  value === "start" || value === "stop";
const isSessionAction = (value: unknown): value is SessionAction =>
  isAction(value) || value === "cancel";
const isSessionId = (value: unknown): value is string =>
  typeof value === "string" && /^[A-Za-z0-9_-]{1,128}$/.test(value);

const toResult = (value: unknown): DictationResult => {
  if (value === true) return true;
  if (typeof value === "object" && value !== null && "text" in value) {
    return typeof value.text === "string" ? { text: value.text } : false;
  }
  return false;
};

/** Resolves false when the signal aborts first; main still finishes (or times out) its request. */
function untilAborted<T>(request: Promise<T>, fallback: T, signal?: AbortSignal): Promise<T> {
  return new Promise<T>((resolve) => {
    const abort = () => resolve(fallback);
    signal?.addEventListener("abort", abort, { once: true });
    const settle = (result: T) => {
      signal?.removeEventListener("abort", abort);
      resolve(result);
    };
    request.then(settle, () => settle(fallback));
  });
}

/** The overlay's `AnnotatorHost`, defined on the page by the guest preload. */
export function makeAnnotatorHost(
  invoke: (action: SessionAction, session?: string) => Promise<unknown>,
) {
  return {
    dictationSession: (
      action: unknown,
      session: unknown,
      options?: { readonly signal?: AbortSignal },
    ): Promise<DictationResult> => {
      const signal = options?.signal;
      if (!isSessionAction(action) || !isSessionId(session) || signal?.aborted) {
        return Promise.resolve(false);
      }
      return untilAborted(invoke(action, session).then(toResult), false, signal);
    },
    dictation: (action: unknown, options?: { readonly signal?: AbortSignal }): Promise<boolean> => {
      const signal = options?.signal;
      if (!isAction(action) || signal?.aborted) return Promise.resolve(false);
      return untilAborted(
        invoke(action).then((result) => result === true),
        false,
        signal,
      );
    },
  };
}

const TIMEOUT_MS = 10_000;
// A session stop waits for the transcript; Operator gives up after about 120 s.
const STOP_TIMEOUT_MS = 130_000;

const httpUrl = (value: string | null): string | null => {
  if (value === null) return null;
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:" ? url.toString() : null;
  } catch {
    return null;
  }
};

/** `https://host[:port]` of a page URL; null for anything that is not an http(s) page. */
function pageOrigin(url: string | undefined): string | null {
  if (url === undefined) return null;
  try {
    const parsed = new URL(url);
    return parsed.protocol === "http:" || parsed.protocol === "https:" ? parsed.origin : null;
  } catch {
    return null;
  }
}

interface Guest {
  readonly id: number;
  readonly ipc: {
    readonly handle: (
      channel: string,
      listener: (
        event: { readonly senderFrame?: { readonly url: string } | null },
        action: unknown,
        session?: unknown,
      ) => unknown,
    ) => void;
    readonly removeHandler: (channel: string) => void;
  };
}

export interface DictationRelay {
  /** Sets (or, with null, clears) where a guest's dictation requests go. */
  readonly setUrls: (webContentsId: number, urls: DictationUrls | null) => void;
  readonly attachGuest: (guest: Guest) => void;
  readonly forget: (webContentsId: number) => void;
  /**
   * POSTs to the guest's registered URL for `action`, as `origin` (the requesting page);
   * false for anything else. With a `session`, POSTs `{ session }` to `/dictate/<action>`.
   */
  readonly send: (
    webContentsId: number,
    action: unknown,
    origin: string | null,
    session?: unknown,
  ) => Promise<DictationResult>;
}

/** `/dictate/<action>` on the origin of the tab's dictation URLs. */
function sessionUrl(registered: DictationUrls | undefined, action: SessionAction): string | null {
  const base = httpUrl(registered?.startUrl ?? null) ?? httpUrl(registered?.stopUrl ?? null);
  return base === null ? null : new URL(`/dictate/${action}`, new URL(base).origin).toString();
}

const transcript = (body: string): DictationResult => {
  try {
    const parsed: unknown = JSON.parse(body);
    if (typeof parsed === "object" && parsed !== null && "text" in parsed) {
      return { text: typeof parsed.text === "string" ? parsed.text : "" };
    }
  } catch {
    // Not JSON: an empty transcript.
  }
  return { text: "" };
};

export function makeDictationRelay(options: {
  /**
   * The app's HttpClient. Electron's `net.fetch` refuses an `Origin` header, which the
   * dictation app needs for its per-website approval.
   */
  readonly fetch: (
    url: string,
    init: RequestInit & { readonly body?: string },
  ) => Promise<{ readonly ok: boolean; readonly body?: string }>;
}): DictationRelay {
  const urls = new Map<number, DictationUrls>();

  const post = (url: string, origin: string | null, timeoutMs: number, body?: string) => {
    const headers: Record<string, string> = {};
    if (origin !== null) headers.Origin = origin;
    if (body !== undefined) headers["Content-Type"] = "application/json";
    return options.fetch(url, {
      method: "POST",
      ...(Object.keys(headers).length === 0 ? {} : { headers }),
      ...(body === undefined ? {} : { body }),
      credentials: "omit",
      redirect: "error",
      signal: AbortSignal.timeout(timeoutMs),
    });
  };

  const sendSession = async (
    registered: DictationUrls | undefined,
    action: unknown,
    origin: string | null,
    session: unknown,
  ): Promise<DictationResult> => {
    if (!isSessionAction(action) || !isSessionId(session)) return false;
    const url = sessionUrl(registered, action);
    if (url === null) return false;
    const stop = action === "stop";
    const response = await post(
      url,
      origin,
      stop ? STOP_TIMEOUT_MS : TIMEOUT_MS,
      JSON.stringify({ session }),
    );
    if (!response.ok) return false;
    return stop ? transcript(response.body ?? "") : true;
  };

  const send: DictationRelay["send"] = async (webContentsId, action, origin, session) => {
    const registered = urls.get(webContentsId);
    try {
      if (session !== undefined) return await sendSession(registered, action, origin, session);
      if (!isAction(action)) return false;
      const url = httpUrl(
        (action === "start" ? registered?.startUrl : registered?.stopUrl) ?? null,
      );
      if (url === null) return false;
      return (await post(url, origin, TIMEOUT_MS)).ok;
    } catch {
      return false;
    }
  };

  return {
    setUrls: (webContentsId, next) => {
      if (next === null || (next.startUrl === null && next.stopUrl === null)) {
        urls.delete(webContentsId);
      } else {
        urls.set(webContentsId, next);
      }
    },
    attachGuest: (guest) => {
      guest.ipc.removeHandler(ANNOTATOR_DICTATION_CHANNEL);
      guest.ipc.handle(ANNOTATOR_DICTATION_CHANNEL, (event, action, session) =>
        send(guest.id, action, pageOrigin(event.senderFrame?.url), session),
      );
    },
    forget: (webContentsId) => {
      urls.delete(webContentsId);
    },
    send,
  };
}
