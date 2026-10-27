import { describe, expect, it, vi } from "vite-plus/test";

import { makeAnnotatorHost, makeDictationRelay } from "./AnnotatorDictation.ts";
import { ANNOTATOR_DICTATION_CHANNEL } from "./GuestProtocol.ts";

const URLS = {
  startUrl: "http://127.0.0.1:12321/dictate",
  stopUrl: "http://127.0.0.1:12321/dictate-stop",
};

describe("makeAnnotatorHost", () => {
  it("asks main for exactly start or stop and answers true only for true", async () => {
    const invoke = vi.fn(async (action: string) => (action === "start" ? true : "yes"));
    const host = makeAnnotatorHost(invoke);
    expect(await host.dictation("start")).toBe(true);
    expect(await host.dictation("stop")).toBe(false);
    expect(await host.dictation("http://127.0.0.1:9/x")).toBe(false);
    expect(await host.dictation("START")).toBe(false);
    expect(invoke.mock.calls).toEqual([["start"], ["stop"]]);
  });

  it("answers false when main fails", async () => {
    const host = makeAnnotatorHost(() => Promise.reject(new Error("gone")));
    expect(await host.dictation("start")).toBe(false);
  });

  it("asks main for a session action and answers a stop with its transcript", async () => {
    const invoke = vi.fn(async (action: string) =>
      action === "stop" ? { status: "complete", text: "Make it red" } : true,
    );
    const host = makeAnnotatorHost(invoke);
    expect(await host.dictationSession("start", "draft-1")).toBe(true);
    expect(await host.dictationSession("stop", "draft-1")).toEqual({ text: "Make it red" });
    expect(await host.dictationSession("cancel", "draft-1")).toBe(true);
    expect(await host.dictationSession("pause", "draft-1")).toBe(false);
    expect(await host.dictationSession("stop", "../x")).toBe(false);
    expect(invoke.mock.calls).toEqual([
      ["start", "draft-1"],
      ["stop", "draft-1"],
      ["cancel", "draft-1"],
    ]);
  });

  it("stops waiting when the signal aborts, and never asks with an aborted signal", async () => {
    const invoke = vi.fn(() => new Promise<unknown>(() => {}));
    const host = makeAnnotatorHost(invoke);
    const controller = new AbortController();
    const pending = host.dictation("start", { signal: controller.signal });
    controller.abort();
    expect(await pending).toBe(false);
    expect(await host.dictation("stop", { signal: controller.signal })).toBe(false);
    expect(invoke).toHaveBeenCalledTimes(1);
  });
});

describe("makeDictationRelay", () => {
  const setup = (ok = true, body = "") => {
    const fetch = vi.fn(async (_url: string, _init: RequestInit) => ({ ok, body }));
    return { fetch, relay: makeDictationRelay({ fetch }) };
  };

  it("POSTs only to the guest's registered URL for the action", async () => {
    const { fetch, relay } = setup();
    relay.setUrls(7, URLS);
    expect(await relay.send(7, "start", null)).toBe(true);
    expect(await relay.send(7, "stop", null)).toBe(true);
    expect(await relay.send(7, "http://127.0.0.1:9/other", null)).toBe(false);
    expect(fetch.mock.calls.map(([url, init]) => [url, init.method, init.credentials])).toEqual([
      [URLS.startUrl, "POST", "omit"],
      [URLS.stopUrl, "POST", "omit"],
    ]);
  });

  it("answers false for an unknown guest, a missing URL, a non-2xx answer or an error", async () => {
    const { fetch, relay } = setup();
    expect(await relay.send(8, "start", null)).toBe(false);
    relay.setUrls(7, { startUrl: URLS.startUrl, stopUrl: null });
    expect(await relay.send(7, "stop", null)).toBe(false);
    expect(fetch).toHaveBeenCalledTimes(0);

    const failing = setup(false);
    failing.relay.setUrls(7, URLS);
    expect(await failing.relay.send(7, "start", null)).toBe(false);

    const throwing = makeDictationRelay({ fetch: () => Promise.reject(new Error("refused")) });
    throwing.setUrls(7, URLS);
    expect(await throwing.send(7, "start", null)).toBe(false);
  });

  it("ignores URLs that are not http(s) and forgets a guest", async () => {
    const { fetch, relay } = setup();
    relay.setUrls(7, { startUrl: "file:///etc/passwd", stopUrl: null });
    expect(await relay.send(7, "start", null)).toBe(false);
    relay.setUrls(7, URLS);
    relay.forget(7);
    expect(await relay.send(7, "start", null)).toBe(false);
    relay.setUrls(7, URLS);
    relay.setUrls(7, null);
    expect(await relay.send(7, "start", null)).toBe(false);
    expect(fetch).toHaveBeenCalledTimes(0);
  });

  it("answers the guest's own channel with its own URLs", async () => {
    const { relay } = setup();
    relay.setUrls(7, URLS);
    let listener:
      | ((event: { senderFrame?: { url: string } | null }, action: unknown) => unknown)
      | undefined;
    relay.attachGuest({
      id: 7,
      ipc: {
        handle: (channel, handler) => {
          if (channel === ANNOTATOR_DICTATION_CHANNEL) listener = handler;
        },
        removeHandler: () => {},
      },
    });
    expect(await listener?.({}, "start")).toBe(true);
  });

  it("sends the requesting page's origin, so the dictation app applies its website approval", async () => {
    const { fetch, relay } = setup();
    relay.setUrls(7, URLS);
    let listener:
      | ((event: { senderFrame?: { url: string } | null }, action: unknown) => unknown)
      | undefined;
    relay.attachGuest({
      id: 7,
      ipc: {
        handle: (channel, handler) => {
          if (channel === ANNOTATOR_DICTATION_CHANNEL) listener = handler;
        },
        removeHandler: () => {},
      },
    });
    await listener?.({ senderFrame: { url: "https://nckrtl.test/articles?x=1#top" } }, "start");
    await listener?.({ senderFrame: { url: "file:///etc/hosts" } }, "stop");
    expect(fetch.mock.calls.map(([, init]) => init.headers ?? null)).toEqual([
      { Origin: "https://nckrtl.test" },
      null,
    ]);
  });

  it("sends a session to /dictate/<action> on the start URL's origin and returns the transcript", async () => {
    const { fetch, relay } = setup(true, JSON.stringify({ status: "complete", text: "Hi" }));
    relay.setUrls(7, URLS);
    expect(await relay.send(7, "start", "https://nckrtl.test", "s1")).toBe(true);
    expect(await relay.send(7, "stop", "https://nckrtl.test", "s1")).toEqual({ text: "Hi" });
    expect(await relay.send(7, "cancel", null, "s1")).toBe(true);
    expect(
      fetch.mock.calls.map(([url, init]) => [url, init.body, init.headers, init.credentials]),
    ).toEqual([
      [
        "http://127.0.0.1:12321/dictate/start",
        '{"session":"s1"}',
        { Origin: "https://nckrtl.test", "Content-Type": "application/json" },
        "omit",
      ],
      [
        "http://127.0.0.1:12321/dictate/stop",
        '{"session":"s1"}',
        { Origin: "https://nckrtl.test", "Content-Type": "application/json" },
        "omit",
      ],
      [
        "http://127.0.0.1:12321/dictate/cancel",
        '{"session":"s1"}',
        { "Content-Type": "application/json" },
        "omit",
      ],
    ]);
  });

  it("answers a failed session request false and an empty stop with no text", async () => {
    const failing = setup(false, JSON.stringify({ error: "cancelled" }));
    failing.relay.setUrls(7, URLS);
    expect(await failing.relay.send(7, "stop", null, "s1")).toBe(false);

    const empty = setup(true, JSON.stringify({ status: "complete", text: "" }));
    empty.relay.setUrls(7, URLS);
    expect(await empty.relay.send(7, "stop", null, "s1")).toEqual({ text: "" });

    const throwing = makeDictationRelay({ fetch: () => Promise.reject(new Error("timeout")) });
    throwing.setUrls(7, URLS);
    expect(await throwing.send(7, "stop", null, "s1")).toBe(false);

    const { fetch, relay } = setup();
    relay.setUrls(7, URLS);
    expect(await relay.send(7, "pause", null, "s1")).toBe(false);
    expect(await relay.send(7, "stop", null, "not a session")).toBe(false);
    expect(await relay.send(8, "stop", null, "s1")).toBe(false);
    expect(fetch).toHaveBeenCalledTimes(0);
  });

  it("passes the session from the guest's channel", async () => {
    const { fetch, relay } = setup(true, JSON.stringify({ text: "Done" }));
    relay.setUrls(7, URLS);
    let listener:
      | ((
          event: { senderFrame?: { url: string } | null },
          action: unknown,
          session?: unknown,
        ) => unknown)
      | undefined;
    relay.attachGuest({
      id: 7,
      ipc: {
        handle: (channel, handler) => {
          if (channel === ANNOTATOR_DICTATION_CHANNEL) listener = handler;
        },
        removeHandler: () => {},
      },
    });
    expect(await listener?.({}, "stop", "s2")).toEqual({ text: "Done" });
    expect(fetch.mock.calls[0]?.[0]).toBe("http://127.0.0.1:12321/dictate/stop");
  });
});
