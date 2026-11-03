import { afterEach, describe, expect, it, vi } from "vite-plus/test";

import { VoiceTranscriptionError } from "@t3tools/client-runtime/voice-input";

const store = vi.hoisted(() => new Map<string, string>());

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

import {
  getOperatorVoiceTranscriber,
  operatorServerBases,
  saveOperatorTranscriptionSettings,
} from "./operatorTranscription";

const signal = new AbortController().signal;

async function transcribe() {
  const prepared = await getOperatorVoiceTranscriber("en-US").prepare({ signal });
  return prepared.transcribe("file:///recording.m4a", { signal });
}

afterEach(() => vi.unstubAllGlobals());

describe("operatorTranscription", () => {
  it("reads addresses like the Operator app", () => {
    expect(operatorServerBases(" 10.0.0.2:8000, https://operator.test/ ,")).toEqual([
      "http://10.0.0.2:8000",
      "https://operator.test",
    ]);
  });

  it("asks for setup when the address or token is missing", async () => {
    await saveOperatorTranscriptionSettings({ engine: "operator", addresses: "", token: "" });
    await expect(transcribe()).rejects.toMatchObject({ code: "server-failed" });
  });

  it("falls through unreachable addresses and sends the token", async () => {
    await saveOperatorTranscriptionSettings({
      engine: "operator",
      addresses: "10.0.0.2:8000, https://operator.test",
      token: "secret",
    });
    const fetch = vi.fn<typeof globalThis.fetch>(async (url) => {
      if (String(url).startsWith("http://10.0.0.2")) throw new TypeError("Network request failed");
      return Response.json({ text: " Hello there. " });
    });
    vi.stubGlobal("fetch", fetch);

    await expect(transcribe()).resolves.toBe("Hello there.");
    expect(fetch.mock.calls.map(([url]) => String(url))).toEqual([
      "http://10.0.0.2:8000/v1/audio/transcriptions",
      "https://operator.test/v1/audio/transcriptions",
    ]);
    expect(fetch.mock.calls[1]![1]!.headers).toEqual({ Authorization: "Bearer secret" });
  });

  it("explains a rejected token", async () => {
    await saveOperatorTranscriptionSettings({
      engine: "operator",
      addresses: "https://operator.test",
      token: "wrong",
    });
    vi.stubGlobal("fetch", async () => new Response("", { status: 401 }));

    const error = await transcribe().catch((cause: unknown) => cause);
    expect(error).toBeInstanceOf(VoiceTranscriptionError);
    expect((error as VoiceTranscriptionError).message).toMatch(/rejected the token/);
  });
});
