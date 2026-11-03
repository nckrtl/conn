import { afterEach, describe, expect, it, vi } from "vite-plus/test";

const store = vi.hoisted(() => new Map<string, string>());
const browser = vi.hoisted(() => ({
  opened: [] as string[],
  dismissed: 0,
  close: (): void => {},
}));

vi.mock("expo-secure-store", () => ({
  getItemAsync: async (key: string) => store.get(key) ?? null,
  setItemAsync: async (key: string, value: string) => void store.set(key, value),
}));

vi.mock("expo-file-system", () => ({
  File: class extends Blob {
    name = "recording.m4a";
    constructor() {
      super(["audio"]);
    }
  },
}));

vi.mock("expo-device", () => ({ deviceName: "Polar" }));
vi.mock("react-native", () => ({ Platform: { OS: "ios" } }));

vi.mock("expo-web-browser", () => ({
  openAuthSessionAsync: (url: string) => {
    browser.opened.push(url);
    return new Promise((resolve) => {
      browser.close = () => resolve({ type: "cancel" });
    });
  },
  dismissAuthSession: () => {
    browser.dismissed += 1;
    browser.close();
  },
}));

import {
  getOperatorTranscriptionSettings,
  getOperatorVoiceTranscriber,
  operatorServerUrl,
  saveOperatorTranscriptionSettings,
  signInToOperator,
} from "./operatorTranscription";

const signal = new AbortController().signal;

async function transcribe() {
  const prepared = await getOperatorVoiceTranscriber("en-US").prepare({ signal });
  return prepared.transcribe("file:///recording.m4a", { signal });
}

function stubServer(tokenAnswers: ReadonlyArray<Record<string, unknown>>) {
  const answers = [...tokenAnswers];
  const fetch = vi.fn<typeof globalThis.fetch>(async (url) => {
    const path = new URL(String(url)).pathname;
    if (path === "/api/devices/authorize") {
      return Response.json({
        device_code: "dev-code",
        user_code: "ABCD",
        verification_uri_complete: "https://operator.test/device?code=ABCD",
        interval: 0,
        expires_in: 60,
      });
    }
    if (path === "/api/devices/token") return Response.json(answers.shift() ?? {});
    return Response.json({ text: " Hello there. " });
  });
  vi.stubGlobal("fetch", fetch);
  return fetch;
}

afterEach(() => {
  vi.unstubAllGlobals();
  browser.opened = [];
  browser.dismissed = 0;
});

describe("operatorTranscription", () => {
  it("reads a typed server address like the Operator app", () => {
    expect(operatorServerUrl("operator.test/").origin).toBe("https://operator.test");
    expect(operatorServerUrl("10.44.0.7:12332").origin).toBe("http://10.44.0.7:12332");
    expect(() => operatorServerUrl("")).toThrow(/server address/);
  });

  it("signs in through the server page and dictates to the address it returns", async () => {
    const fetch = stubServer([
      { error: "authorization_pending" },
      { token: "device-token", user: "Nick", team: "Home", openai: "http://10.44.0.7:12331" },
    ]);

    await expect(signInToOperator("operator.test")).resolves.toBe(true);
    expect(browser.opened).toEqual(["https://operator.test/device?code=ABCD"]);
    expect(browser.dismissed).toBe(1);
    expect(getOperatorTranscriptionSettings()).toMatchObject({
      engine: "operator",
      server: "https://operator.test",
      speech: "http://10.44.0.7:12331",
      token: "device-token",
      account: "Nick · Home",
    });

    await expect(transcribe()).resolves.toBe("Hello there.");
    const upload = fetch.mock.calls.at(-1)!;
    expect(String(upload[0])).toBe("http://10.44.0.7:12331/v1/audio/transcriptions");
    expect(upload[1]!.headers).toEqual({ Authorization: "Bearer device-token" });
  });

  it("reports a denied sign-in", async () => {
    stubServer([{ error: "access_denied" }]);
    await expect(signInToOperator("operator.test")).rejects.toThrow(/denied/);
  });

  it("asks to sign in again when the server rejects the token", async () => {
    await saveOperatorTranscriptionSettings({
      engine: "operator",
      speech: "http://10.44.0.7:12331",
      token: "revoked",
    });
    vi.stubGlobal("fetch", async () => new Response("", { status: 401 }));
    await expect(transcribe()).rejects.toMatchObject({
      code: "server-failed",
      message: expect.stringMatching(/Sign in again/),
    });
  });
});
