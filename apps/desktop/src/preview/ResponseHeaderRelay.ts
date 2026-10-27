// Reads browser-tab responses in main. Pages with a CSP get no inline toolbar data, but every
// response carries it in `x-toolbar` headers: the document's payload waits for the guest
// preload, fetch/XHR payloads go straight to it.
import {
  decodeToolbarHeaders,
  minimalToolbarRow,
  type ToolbarHeaderPayload,
} from "@t3tools/shared/laravelToolbarHeaders";
import type { OnHeadersReceivedListenerDetails, Session } from "electron";

import {
  LARAVEL_TOOLBAR_DOCUMENT_CHANNEL,
  LARAVEL_TOOLBAR_RESPONSE_CHANNEL,
} from "./GuestProtocol.ts";

interface DocumentResponse {
  /** Follows in-page navigations (pushState, Inertia visits) of the same document. */
  url: string;
  /** Taken by the guest preload once, for this document only. */
  payload: ToolbarHeaderPayload | null;
}

/** Two URLs of the same document: only the fragment may differ. */
export function sameDocumentUrl(a: string, b: string): boolean {
  const strip = (url: string) => {
    const hash = url.indexOf("#");
    return hash === -1 ? url : url.slice(0, hash);
  };
  return strip(a) === strip(b);
}

function headerValue(headers: Record<string, ReadonlyArray<string>>, name: string) {
  for (const [key, values] of Object.entries(headers)) {
    if (key.toLowerCase() === name) return values[0] ?? null;
  }
  return null;
}

/** The toolbar payload of one response; a summary without a row gets one from the request. */
export function toolbarPayloadFromResponse(response: {
  readonly method: string;
  readonly url: string;
  readonly responseHeaders?: Record<string, ReadonlyArray<string>> | undefined;
}): ToolbarHeaderPayload | null {
  const headers = response.responseHeaders ?? {};
  const payload = decodeToolbarHeaders(
    headerValue(headers, "x-toolbar"),
    headerValue(headers, "x-toolbar-summary"),
  );
  if (payload?.kind !== "summary" || payload.row !== null) return payload;
  return { ...payload, row: minimalToolbarRow(payload.id, response) };
}

interface Guest {
  readonly id: number;
  readonly ipc: {
    readonly handle: (
      channel: string,
      listener: (event: { readonly senderFrame: { readonly url: string } | null }) => unknown,
    ) => void;
    readonly removeHandler: (channel: string) => void;
  };
}

export interface ResponseHeaderRelay {
  /** Idempotent; Electron keeps one `onHeadersReceived` listener per session. */
  readonly installSession: (session: Session) => void;
  /** Lets the guest's preload take its document payload. */
  readonly attachGuest: (guest: Guest) => void;
  readonly forget: (webContentsId: number) => void;
  /** The guest's main frame moved to `url` without loading a new document. */
  readonly navigatedInPage: (webContentsId: number, url: string) => void;
  /** Exposed for tests; the session listener calls it. */
  readonly onHeadersReceived: (
    details: Pick<
      OnHeadersReceivedListenerDetails,
      "method" | "url" | "resourceType" | "webContentsId" | "responseHeaders"
    >,
  ) => void;
}

export function makeResponseHeaderRelay(options: {
  /** Sends to a guest webContents, if it still exists. */
  readonly sendToGuest: (webContentsId: number, channel: string, payload: unknown) => void;
}): ResponseHeaderRelay {
  const sessions = new WeakSet<Session>();
  const documents = new Map<number, DocumentResponse>();

  const onHeadersReceived: ResponseHeaderRelay["onHeadersReceived"] = (details) => {
    const id = details.webContentsId;
    if (id === undefined) return;
    if (details.resourceType === "xhr") {
      // Electron reports fetch() as xhr too.
      const payload = toolbarPayloadFromResponse(details);
      if (payload) options.sendToGuest(id, LARAVEL_TOOLBAR_RESPONSE_CHANNEL, payload);
      return;
    }
    // Redirects pass through here too; the last response is the document's.
    if (details.resourceType === "mainFrame")
      documents.set(id, { url: details.url, payload: toolbarPayloadFromResponse(details) });
  };

  return {
    installSession: (session) => {
      if (sessions.has(session)) return;
      sessions.add(session);
      session.webRequest.onHeadersReceived((details, callback) => {
        try {
          onHeadersReceived(details);
        } catch {}
        // The request stays blocked until the callback runs.
        callback({});
      });
    },
    attachGuest: (guest) => {
      guest.ipc.removeHandler(LARAVEL_TOOLBAR_DOCUMENT_CHANNEL);
      guest.ipc.handle(LARAVEL_TOOLBAR_DOCUMENT_CHANNEL, (event) => {
        const document = documents.get(guest.id);
        const url = event.senderFrame?.url;
        if (!document || url === undefined || !sameDocumentUrl(document.url, url)) return null;
        const payload = document.payload;
        document.payload = null;
        return payload;
      });
    },
    forget: (webContentsId) => {
      documents.delete(webContentsId);
    },
    navigatedInPage: (webContentsId, url) => {
      const document = documents.get(webContentsId);
      if (document) document.url = url;
    },
    onHeadersReceived,
  };
}
