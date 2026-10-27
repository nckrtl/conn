import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";
import { dictationEnabled, stopsOnNextElement, triggersDesktopDictation } from "./dictation";
import { resolveDictationSettings } from "./dictation-settings";
import {
  cancelHostSession,
  stopHostSession,
  triggerDictation,
  usesHostSessions,
  type AnnotatorHost,
} from "./dictation-trigger";

const fetch = vi.fn();

beforeEach(() => {
  vi.stubGlobal("window", { location: { href: "https://app.example/page" } });
  vi.stubGlobal("fetch", fetch);
});
afterEach(() => {
  vi.unstubAllGlobals();
  fetch.mockReset();
});

function host(dictation: AnnotatorHost["dictation"]) {
  const spy = vi.fn(dictation);
  window.__ANNOTATOR_HOST__ = { dictation: spy };
  return spy;
}

it("parses the host provider and its snake_case stop option", () => {
  window.__TOOLBAR_AGENTATION__ = {
    dictation: { provider: "host", stop_on_next_element: false, auto_start: false },
  };
  expect(resolveDictationSettings()).toEqual({
    provider: "host",
    wsUrl: "",
    codec: "auto",
    autoStart: false,
    stopOnNextElement: false,
  });
  expect(
    resolveDictationSettings({ dictation: { provider: "host", stopOnNextElement: true } })
      .stopOnNextElement,
  ).toBe(true);
});

it("is configured only while the host defines a dictation function", () => {
  const settings = { provider: "host" };
  expect(dictationEnabled(settings)).toBe(false);
  window.__ANNOTATOR_HOST__ = {} as AnnotatorHost;
  expect(dictationEnabled(settings)).toBe(false);
  host(async () => true);
  expect(dictationEnabled(settings)).toBe(true);
  expect(dictationEnabled({ provider: "post" })).toBe(false);
  expect(triggersDesktopDictation(settings)).toBe(true);
});

it("stops on the next element unless the host option turns it off", () => {
  expect(stopsOnNextElement({ provider: "host" })).toBe(true);
  expect(stopsOnNextElement({ provider: "host", stopOnNextElement: false })).toBe(false);
  expect(stopsOnNextElement({ provider: "post", postUrl: "https://x.test/start" })).toBe(false);
  expect(stopsOnNextElement({ provider: "post", stopUrl: "https://x.test/stop" })).toBe(true);
});

it.each(["start", "stop"] as const)("asks the host to %s without a request", async (action) => {
  const dictation = host(async () => true);
  const signal = new AbortController().signal;

  await triggerDictation(
    { provider: "host", postUrl: "https://x.test/start", stopUrl: "https://x.test/stop" },
    action,
    signal,
  );

  expect(dictation).toHaveBeenCalledExactlyOnceWith(action, { signal });
  expect(fetch).not.toHaveBeenCalled();
});

it.each([
  ["start", async (): Promise<boolean> => false, "The host did not start dictation."],
  [
    "stop",
    async (): Promise<boolean> => false,
    "Could not stop dictation: The host did not stop dictation.",
  ],
  ["start", async () => Promise.reject(new Error("No app")), "No app"],
  ["stop", async () => Promise.reject(new Error("No app")), "Could not stop dictation: No app"],
  [
    "stop",
    () => {
      throw new Error("Sync throw");
    },
    "Could not stop dictation: Sync throw",
  ],
] as const)("fails a host %s that returns false or rejects", async (action, dictation, message) => {
  host(dictation as AnnotatorHost["dictation"]);

  await expect(
    triggerDictation({ provider: "host" }, action, new AbortController().signal),
  ).rejects.toThrow(message);
  expect(fetch).not.toHaveBeenCalled();
});

it("fails when the host function is gone", async () => {
  await expect(
    triggerDictation({ provider: "host" }, "start", new AbortController().signal),
  ).rejects.toThrow("The host has no dictation function.");
});

it("rejects with the abort reason when the host does not settle in time", async () => {
  host(() => new Promise<boolean>(() => {}));

  await expect(
    triggerDictation({ provider: "host" }, "stop", AbortSignal.timeout(20)),
  ).rejects.toMatchObject({ name: "TimeoutError" });
});

function sessionHost(dictationSession: NonNullable<AnnotatorHost["dictationSession"]>) {
  const spy = vi.fn(dictationSession);
  window.__ANNOTATOR_HOST__ = { dictation: async () => true, dictationSession: spy };
  return spy;
}

it("uses sessions only for a host that offers them", () => {
  host(async () => true);
  expect(usesHostSessions({ provider: "host" })).toBe(false);
  sessionHost(async () => true);
  expect(usesHostSessions({ provider: "host" })).toBe(true);
  expect(usesHostSessions({ provider: "post", postUrl: "https://x.test/start" })).toBe(false);
});

it("shares one stop request per session and answers its transcript", async () => {
  let answer!: (result: { text: string }) => void;
  const dictationSession = sessionHost(
    () =>
      new Promise((resolve) => {
        answer = resolve;
      }),
  );
  const first = stopHostSession("s1");
  const second = stopHostSession("s1");
  answer({ text: "Hello" });
  expect(await Promise.all([first, second])).toEqual(["Hello", "Hello"]);
  expect(dictationSession).toHaveBeenCalledOnce();
  expect(dictationSession.mock.calls[0]?.slice(0, 2)).toEqual(["stop", "s1"]);
});

it("fails a stop the host refuses, and cancels by id without failing", async () => {
  const dictationSession = sessionHost(async (action) => action !== "stop");
  await expect(stopHostSession("s2")).rejects.toThrow("The host did not stop dictation.");
  cancelHostSession("s2");
  expect(dictationSession.mock.calls.map(([action, session]) => [action, session])).toEqual([
    ["stop", "s2"],
    ["cancel", "s2"],
  ]);
});
