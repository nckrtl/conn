// Reads browser-tab responses in main. Pages with a CSP get no inline toolbar data, but every
// response carries it in `x-toolbar` headers: the document's payload waits for the guest
// preload, fetch/XHR payloads go straight to it. Each document's CSP also gets the tab's
// @nckrtl/annotator origin, so the overlay loads.
import {
  decodeToolbarHeaders,
  minimalToolbarRow,
  type ToolbarHeaderPayload,
} from "@t3tools/shared/laravelToolbarHeaders";
import type { OnHeadersReceivedListenerDetails, Session } from "electron";

import { allowOriginInPolicyHeaders, hasEnforcedPolicy } from "./ContentSecurityPolicy.ts";
import {
  LARAVEL_TOOLBAR_DOCUMENT_CHANNEL,
  LARAVEL_TOOLBAR_RESPONSE_CHANNEL,
} from "./GuestProtocol.ts";

interface DocumentResponse {
  /** Follows in-page navigations (pushState, Inertia visits) of the same document. */
  url: string;
  /** Taken by the guest preload once, for this document only. */
  payload: ToolbarHeaderPayload | null;
  /** The annotator origin the response's CSP was amended for. */
  readonly annotatorOrigin: string | null;
  readonly enforcedPolicy: boolean;
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
  /**
   * Sets (or, with null, clears) the annotator origin of a guest's next documents. Returns
   * whether the current document already loaded with it allowed; unknown documents count as
   * allowed, so a caller never reloads on a guess.
   */
  readonly setAnnotatorOrigin: (
    webContentsId: number,
    origin: string | null,
    documentUrl: string,
  ) => boolean;
  /** Exposed for tests; the session listener calls it. */
  readonly onHeadersReceived: (
    details: Pick<
      OnHeadersReceivedListenerDetails,
      "method" | "url" | "resourceType" | "webContentsId" | "responseHeaders"
    >,
  ) => Record<string, string[]> | undefined;
}

export function makeResponseHeaderRelay(options: {
  /** Sends to a guest webContents, if it still exists. */
  readonly sendToGuest: (webContentsId: number, channel: string, payload: unknown) => void;
}): ResponseHeaderRelay {
  const sessions = new WeakSet<Session>();
  const documents = new Map<number, DocumentResponse>();
  const annotatorOrigins = new Map<number, string>();

  const onHeadersReceived: ResponseHeaderRelay["onHeadersReceived"] = (details) => {
    const id = details.webContentsId;
    if (id === undefined) return undefined;
    const headers = details.responseHeaders ?? {};
    if (details.resourceType === "xhr") {
      // Electron reports fetch() as xhr too.
      const payload = toolbarPayloadFromResponse(details);
      if (payload) options.sendToGuest(id, LARAVEL_TOOLBAR_RESPONSE_CHANNEL, payload);
      return undefined;
    }
    if (details.resourceType !== "mainFrame") return undefined;
    const origin = annotatorOrigins.get(id) ?? null;
    const amended = origin === null ? null : allowOriginInPolicyHeaders(headers, origin);
    // Redirects pass through here too; the last response is the document's.
    documents.set(id, {
      url: details.url,
      payload: toolbarPayloadFromResponse(details),
      annotatorOrigin: origin,
      enforcedPolicy: amended?.enforced ?? hasEnforcedPolicy(headers),
    });
    return amended?.changed ? amended.headers : undefined;
  };

  return {
    installSession: (session) => {
      if (sessions.has(session)) return;
      sessions.add(session);
      session.webRequest.onHeadersReceived((details, callback) => {
        let responseHeaders: Record<string, string[]> | undefined;
        try {
          responseHeaders = onHeadersReceived(details);
        } catch {
          responseHeaders = undefined;
        }
        // The request stays blocked until the callback runs.
        callback(responseHeaders ? { responseHeaders } : {});
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
      annotatorOrigins.delete(webContentsId);
    },
    navigatedInPage: (webContentsId, url) => {
      const document = documents.get(webContentsId);
      if (document) document.url = url;
    },
    setAnnotatorOrigin: (webContentsId, origin, documentUrl) => {
      if (origin === null) annotatorOrigins.delete(webContentsId);
      else annotatorOrigins.set(webContentsId, origin);
      const document = documents.get(webContentsId);
      if (origin === null || !document || !sameDocumentUrl(document.url, documentUrl)) return true;
      return !document.enforcedPolicy || document.annotatorOrigin === origin;
    },
    onHeadersReceived,
  };
}
