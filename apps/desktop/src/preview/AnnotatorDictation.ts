// The annotator overlay's `host` dictation: main POSTs to the tab's registered URL, so page CSP
// cannot block it and a page names only the action. The request carries the page's origin,
// so the dictation app applies its own per-website approval (Operator's allowed websites).
import { ANNOTATOR_DICTATION_CHANNEL } from "./GuestProtocol.ts";

export type DictationAction = "start" | "stop";

export interface DictationUrls {
  readonly startUrl: string | null;
  readonly stopUrl: string | null;
}

const isAction = (value: unknown): value is DictationAction =>
  value === "start" || value === "stop";

/** The overlay's `AnnotatorHost`, defined on the page by the guest preload. */
export function makeAnnotatorHost(invoke: (action: DictationAction) => Promise<unknown>) {
  return {
    dictation: (action: unknown, options?: { readonly signal?: AbortSignal }): Promise<boolean> => {
      const signal = options?.signal;
      if (!isAction(action) || signal?.aborted) return Promise.resolve(false);
      // An abort stops the wait; main still finishes (or times out) its request.
      return new Promise<boolean>((resolve) => {
        const abort = () => resolve(false);
        signal?.addEventListener("abort", abort, { once: true });
        const settle = (result: boolean) => {
          signal?.removeEventListener("abort", abort);
          resolve(result);
        };
        invoke(action).then(
          (result) => settle(result === true),
          () => settle(false),
        );
      });
    },
  };
}

const TIMEOUT_MS = 10_000;

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
export function pageOrigin(url: string | undefined): string | null {
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
   * false for anything else.
   */
  readonly send: (
    webContentsId: number,
    action: unknown,
    origin: string | null,
  ) => Promise<boolean>;
}

export function makeDictationRelay(options: {
  /**
   * The app's HttpClient. Electron's `net.fetch` refuses an `Origin` header, which the
   * dictation app needs for its per-website approval.
   */
  readonly fetch: (url: string, init: RequestInit) => Promise<{ readonly ok: boolean }>;
}): DictationRelay {
  const urls = new Map<number, DictationUrls>();

  const send: DictationRelay["send"] = async (webContentsId, action, origin) => {
    if (!isAction(action)) return false;
    const registered = urls.get(webContentsId);
    const url = httpUrl((action === "start" ? registered?.startUrl : registered?.stopUrl) ?? null);
    if (url === null) return false;
    try {
      const response = await options.fetch(url, {
        method: "POST",
        ...(origin === null ? {} : { headers: { Origin: origin } }),
        credentials: "omit",
        redirect: "error",
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
      return response.ok;
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
      guest.ipc.handle(ANNOTATOR_DICTATION_CHANNEL, (event, action) =>
        send(guest.id, action, pageOrigin(event.senderFrame?.url)),
      );
    },
    forget: (webContentsId) => {
      urls.delete(webContentsId);
    },
    send,
  };
}
