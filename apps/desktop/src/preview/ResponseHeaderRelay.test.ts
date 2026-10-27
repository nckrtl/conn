import { describe, expect, it, vi } from "vite-plus/test";

import {
  LARAVEL_TOOLBAR_DOCUMENT_CHANNEL,
  LARAVEL_TOOLBAR_RESPONSE_CHANNEL,
} from "./GuestProtocol.ts";
import {
  makeResponseHeaderRelay,
  sameDocumentUrl,
  toolbarPayloadFromResponse,
} from "./ResponseHeaderRelay.ts";

const base64 = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64");
const ANNOTATOR = "http://10.44.0.7:40953";
const PAGE = "https://nckrtl.test/";
const CSP = "script-src 'self'; default-src 'self'";

const mainFrame = (headers: Record<string, string[]>, url = PAGE) => ({
  method: "GET",
  url,
  resourceType: "mainFrame" as const,
  webContentsId: 7,
  responseHeaders: headers,
});

function setup() {
  const sendToGuest = vi.fn();
  const relay = makeResponseHeaderRelay({ sendToGuest });
  let documentHandler: ((event: { senderFrame: { url: string } | null }) => unknown) | undefined;
  relay.attachGuest({
    id: 7,
    ipc: {
      handle: (channel, listener) => {
        if (channel === LARAVEL_TOOLBAR_DOCUMENT_CHANNEL) documentHandler = listener;
      },
      removeHandler: () => {},
    },
  });
  const takeDocument = (url: string) => documentHandler?.({ senderFrame: { url } });
  return { relay, sendToGuest, takeDocument };
}

describe("sameDocumentUrl", () => {
  it("ignores only the fragment", () => {
    expect(sameDocumentUrl("https://a.test/x?y=1#top", "https://a.test/x?y=1")).toBe(true);
    expect(sameDocumentUrl("https://a.test/x?y=1", "https://a.test/x?y=2")).toBe(false);
    expect(sameDocumentUrl("https://a.test/x", "https://a.test/y#x")).toBe(false);
  });
});

describe("toolbarPayloadFromResponse", () => {
  it("reads the headers in any case", () => {
    expect(
      toolbarPayloadFromResponse({
        method: "GET",
        url: PAGE,
        responseHeaders: { "X-Toolbar": [base64({ request_id: "r1" })] },
      }),
    ).toEqual({ kind: "full", data: { request_id: "r1" } });
  });

  it("gives a summary without a row one built from the request", () => {
    expect(
      toolbarPayloadFromResponse({
        method: "POST",
        url: "https://nckrtl.test/api/save?draft=1",
        responseHeaders: { "x-toolbar-summary": [base64({ request_id: "r2" })] },
      }),
    ).toEqual({
      kind: "summary",
      id: "r2",
      row: { id: "r2", method: "POST", uri: "/api/save?draft=1" },
    });
  });

  it("returns null without toolbar headers", () => {
    expect(toolbarPayloadFromResponse({ method: "GET", url: PAGE })).toBeNull();
  });
});

describe("makeResponseHeaderRelay", () => {
  it("keeps the document payload for the guest, once, for that document only", () => {
    const { relay, takeDocument } = setup();
    relay.onHeadersReceived(mainFrame({ "x-toolbar": [base64({ request_id: "r1" })] }));

    expect(takeDocument("https://nckrtl.test/other")).toBeNull();
    expect(takeDocument(`${PAGE}#section`)).toEqual({ kind: "full", data: { request_id: "r1" } });
    expect(takeDocument(PAGE)).toBeNull();
  });

  it("keeps the last response of a redirect chain", () => {
    const { relay, takeDocument } = setup();
    relay.onHeadersReceived(
      mainFrame({ "x-toolbar": [base64({ request_id: "r1" })] }, "https://nckrtl.test/old"),
    );
    relay.onHeadersReceived(mainFrame({ "x-toolbar": [base64({ request_id: "r2" })] }));
    expect(takeDocument(PAGE)).toEqual({ kind: "full", data: { request_id: "r2" } });
  });

  it("forgets the payload of an earlier document when the next has none", () => {
    const { relay, takeDocument } = setup();
    relay.onHeadersReceived(mainFrame({ "x-toolbar": [base64({ request_id: "r1" })] }));
    relay.onHeadersReceived(mainFrame({}));
    expect(takeDocument(PAGE)).toBeNull();
  });

  it("sends fetch and XHR payloads to the guest", () => {
    const { relay, sendToGuest } = setup();
    relay.onHeadersReceived({
      method: "GET",
      url: "https://nckrtl.test/api",
      resourceType: "xhr",
      webContentsId: 7,
      responseHeaders: {
        "x-toolbar-summary": [base64({ request_id: "r3", history_row: { id: "r3" } })],
      },
    });
    relay.onHeadersReceived({
      method: "GET",
      url: "https://nckrtl.test/api",
      resourceType: "xhr",
      webContentsId: 7,
      responseHeaders: {},
    });
    expect(sendToGuest.mock.calls).toEqual([
      [7, LARAVEL_TOOLBAR_RESPONSE_CHANNEL, { kind: "summary", id: "r3", row: { id: "r3" } }],
    ]);
  });

  it("amends the document CSP for the guest's annotator origin only", () => {
    const { relay } = setup();
    expect(relay.onHeadersReceived(mainFrame({ "content-security-policy": [CSP] }))).toBe(
      undefined,
    );
    relay.setAnnotatorOrigin(7, ANNOTATOR, PAGE);
    expect(relay.onHeadersReceived(mainFrame({ "content-security-policy": [CSP] }))).toEqual({
      "content-security-policy": [
        `script-src 'self' ${ANNOTATOR}; default-src 'self'; connect-src 'self' ${ANNOTATOR} ws://10.44.0.7:40953`,
      ],
    });
    expect(
      relay.onHeadersReceived({
        ...mainFrame({ "content-security-policy": [CSP] }),
        webContentsId: 8,
      }),
    ).toBe(undefined);
    expect(
      relay.onHeadersReceived({
        ...mainFrame({ "content-security-policy": [CSP] }),
        resourceType: "subFrame",
      }),
    ).toBe(undefined);
  });

  it("reports whether the current document loaded with the annotator allowed", () => {
    const { relay } = setup();
    // No document seen yet: never ask for a reload on a guess.
    expect(relay.setAnnotatorOrigin(7, ANNOTATOR, PAGE)).toBe(true);
    relay.setAnnotatorOrigin(7, null, PAGE);

    relay.onHeadersReceived(mainFrame({ "content-security-policy": [CSP] }));
    expect(relay.setAnnotatorOrigin(7, ANNOTATOR, PAGE)).toBe(false);
    // Another document than the one that loaded counts as unknown.
    expect(relay.setAnnotatorOrigin(7, ANNOTATOR, "https://nckrtl.test/next")).toBe(true);

    relay.onHeadersReceived(mainFrame({ "content-security-policy": [CSP] }));
    expect(relay.setAnnotatorOrigin(7, ANNOTATOR, PAGE)).toBe(true);
    expect(relay.setAnnotatorOrigin(7, "http://10.44.0.7:1", PAGE)).toBe(false);
  });

  it("follows the document through in-page navigations", () => {
    const { relay } = setup();
    relay.onHeadersReceived(mainFrame({ "content-security-policy": [CSP] }));
    // An Inertia visit or another pushState keeps the document that loaded with this policy.
    relay.navigatedInPage(7, "https://nckrtl.test/articles");
    expect(relay.setAnnotatorOrigin(7, ANNOTATOR, "https://nckrtl.test/articles")).toBe(false);
  });

  it("counts a document without an enforced policy as allowed", () => {
    const { relay } = setup();
    relay.onHeadersReceived(mainFrame({ "content-security-policy-report-only": [CSP] }));
    expect(relay.setAnnotatorOrigin(7, ANNOTATOR, PAGE)).toBe(true);
  });

  it("forgets a guest's state", () => {
    const { relay, takeDocument } = setup();
    relay.setAnnotatorOrigin(7, ANNOTATOR, PAGE);
    relay.onHeadersReceived(mainFrame({ "x-toolbar": [base64({ request_id: "r1" })] }));
    relay.forget(7);
    expect(takeDocument(PAGE)).toBeNull();
    expect(relay.onHeadersReceived(mainFrame({ "content-security-policy": [CSP] }))).toBe(
      undefined,
    );
  });

  it("installs one listener per session and always answers the request", () => {
    const { relay } = setup();
    const onHeadersReceived = vi.fn();
    const session = { webRequest: { onHeadersReceived } } as unknown as Electron.Session;
    relay.installSession(session);
    relay.installSession(session);
    expect(onHeadersReceived).toHaveBeenCalledTimes(1);

    const callback = vi.fn();
    const listener = onHeadersReceived.mock.calls[0]![0];
    listener(
      {
        ...mainFrame({}),
        get responseHeaders(): never {
          throw new Error("broken");
        },
      },
      callback,
    );
    expect(callback).toHaveBeenCalledWith({});
  });
});
