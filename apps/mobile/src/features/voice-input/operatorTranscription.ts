import * as Device from "expo-device";
import { File } from "expo-file-system";
import * as SecureStore from "expo-secure-store";
import * as WebBrowser from "expo-web-browser";
import { Platform } from "react-native";

import { randomHex } from "../../lib/uuid";
import {
  VoiceTranscriptionError,
  throwIfVoiceTranscriptionAborted,
  type VoiceTranscriber,
} from "@t3tools/client-runtime/voice-input";

/**
 * Conn: voice input can send recordings to an Operator server (nckrtl/operator) instead of the
 * on-device recognizer. Sign-in is Operator's device-code flow, as in the Operator iPhone app:
 * the server's own login page opens in a browser sheet, and the server issues a device token and
 * the dictation address. Recordings go to that address's `/v1/audio/transcriptions` as is (M4A).
 */

export type VoiceTranscriptionEngine = "device" | "operator";

export interface OperatorTranscriptionSettings {
  readonly engine: VoiceTranscriptionEngine;
  /** The server's web address as entered, such as https://operator.test. */
  readonly server: string;
  /** Where dictation goes, from the sign-in answer. Empty until signed in. */
  readonly speech: string;
  readonly token: string;
  /** "user · team · device" from the sign-in answer. */
  readonly account: string;
  readonly loaded: boolean;
}

const STORAGE_KEY = "conn.voice-transcription.v2";
const DEVICE_KEY = "conn.voice-transcription.device-key";
const REQUEST_TIMEOUT_MS = 10_000;
const UPLOAD_TIMEOUT_MS = 120_000;
const OPENAI_PORT = 12331;

let settings: OperatorTranscriptionSettings = {
  engine: "device",
  server: "",
  speech: "",
  token: "",
  account: "",
  loaded: false,
};
const listeners = new Set<() => void>();

function publish(next: OperatorTranscriptionSettings): void {
  settings = next;
  for (const listener of listeners) listener();
}

function text(value: unknown): string {
  return typeof value === "string" ? value : "";
}

let loading: Promise<void> | null = null;
export function loadOperatorTranscriptionSettings(): Promise<void> {
  loading ??= SecureStore.getItemAsync(STORAGE_KEY)
    .then((raw) => {
      const parsed = raw === null ? {} : (JSON.parse(raw) as Record<string, unknown>);
      publish({
        engine: parsed.engine === "operator" ? "operator" : "device",
        server: text(parsed.server),
        speech: text(parsed.speech),
        token: text(parsed.token),
        account: text(parsed.account),
        loaded: true,
      });
    })
    .catch(() => publish({ ...settings, loaded: true }));
  return loading;
}

export async function saveOperatorTranscriptionSettings(
  patch: Partial<Omit<OperatorTranscriptionSettings, "loaded">>,
): Promise<void> {
  await loadOperatorTranscriptionSettings();
  const { loaded: _loaded, ...next } = { ...settings, ...patch };
  publish({ ...next, loaded: true });
  await SecureStore.setItemAsync(STORAGE_KEY, JSON.stringify(next));
}

export function getOperatorTranscriptionSettings(): OperatorTranscriptionSettings {
  return settings;
}

export function subscribeOperatorTranscriptionSettings(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** `operator.test` means https; a host with a port, such as `10.44.0.7:12332`, means http. */
export function operatorServerUrl(entered: string): URL {
  const trimmed = entered.trim().replace(/^\/+|\/+$/g, "");
  const full = trimmed.includes("://")
    ? trimmed
    : `${trimmed.includes(":") ? "http" : "https"}://${trimmed}`;
  try {
    const url = new URL(full);
    if ((url.protocol === "http:" || url.protocol === "https:") && url.hostname) return url;
  } catch {
    // Reported below.
  }
  throw new Error("Enter the server address, such as https://operator.test.");
}

/** The dictation base from the server's `openai` URL, or this host on the OpenAI port. */
export function operatorSpeechBase(server: URL, openai: unknown): string {
  const given = text(openai).replace(/\/+$/, "");
  return given.length > 0 ? given : `http://${server.hostname}:${OPENAI_PORT}`;
}

async function deviceKey(): Promise<string> {
  const saved = await SecureStore.getItemAsync(DEVICE_KEY);
  if (saved && saved.length >= 16) return saved;
  const made = randomHex(16);
  await SecureStore.setItemAsync(DEVICE_KEY, made);
  return made;
}

async function postJson(
  url: string,
  body: Record<string, unknown> | null,
  token?: string,
): Promise<{ readonly status: number; readonly json: Record<string, unknown> }> {
  let response: Response;
  try {
    response = await fetch(url, {
      method: "POST",
      headers: {
        Accept: "application/json",
        "Content-Type": "application/json",
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
      body: body === null ? null : JSON.stringify(body),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch {
    throw new Error(`The Operator server does not answer at ${hostOf(url)}.`);
  }
  const json = (await response.json().catch(() => ({}))) as Record<string, unknown>;
  return { status: response.status, json };
}

function accountLabel(json: Record<string, unknown>): string {
  const device = json.device as { readonly name?: unknown } | undefined;
  return [text(json.user), text(json.team), text(device?.name)]
    .filter((part) => part.length > 0)
    .join(" · ");
}

let signInAbort: AbortController | null = null;

/**
 * Opens the server's sign-in page and waits until it approves this device. Closing the sheet
 * cancels; the result is then false. Saves the token and dictation address on success.
 */
export async function signInToOperator(entered: string): Promise<boolean> {
  signInAbort?.abort();
  const abort = new AbortController();
  signInAbort = abort;
  const server = operatorServerUrl(entered);
  const started = await postJson(`${server.origin}/api/devices/authorize`, {
    name: Device.deviceName?.trim() || "Conn",
    platform: Platform.OS === "ios" ? "ios" : "other",
    device_key: await deviceKey(),
  });
  const deviceCode = text(started.json.device_code);
  const page = text(started.json.verification_uri_complete);
  if (deviceCode.length === 0 || page.length === 0 || hostOf(page) !== server.host) {
    throw new Error(
      started.status >= 400
        ? `The Operator server answered ${started.status}.`
        : "Unexpected answer from the Operator server.",
    );
  }
  const interval = Math.max(1, Number(started.json.interval) || 2) * 1000;
  const expiresAt = Date.now() + (Number(started.json.expires_in) || 600) * 1000;

  // The sheet only shows the server's pages; approval is learned by polling, as Operator does.
  let approved = false;
  void WebBrowser.openAuthSessionAsync(page, null).then(() => {
    if (!approved) abort.abort();
  });
  try {
    while (Date.now() < expiresAt) {
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, interval);
        abort.signal.addEventListener(
          "abort",
          () => {
            clearTimeout(timer);
            resolve();
          },
          { once: true },
        );
      });
      if (abort.signal.aborted) return false;
      const answer = await postJson(`${server.origin}/api/devices/token`, {
        device_code: deviceCode,
      });
      const token = text(answer.json.token);
      if (token.length > 0) {
        approved = true;
        await saveOperatorTranscriptionSettings({
          engine: "operator",
          server: server.origin,
          speech: operatorSpeechBase(server, answer.json.openai),
          token,
          account: accountLabel(answer.json),
        });
        return true;
      }
      const error = text(answer.json.error);
      if (error === "authorization_pending" || error === "slow_down") continue;
      throw new Error(
        error === "access_denied" ? "The sign-in was denied." : "The code expired. Sign in again.",
      );
    }
    throw new Error("The code expired. Sign in again.");
  } finally {
    if (signInAbort === abort) signInAbort = null;
    if (!abort.signal.aborted) WebBrowser.dismissAuthSession();
  }
}

export async function signOutOfOperator(): Promise<void> {
  const { server, token } = settings;
  await saveOperatorTranscriptionSettings({ token: "", account: "", speech: "" });
  if (server && token) {
    await postJson(`${server}/api/devices/sign-out`, null, token).catch(() => {});
  }
}

export function getOperatorVoiceTranscriber(locale: string): VoiceTranscriber {
  const { speech, token } = settings;
  if (speech.length === 0 || token.length === 0) {
    return {
      prepare: async () => {
        throw new VoiceTranscriptionError({
          code: "transcription-failed",
          message: "Sign in to your Operator server in Settings › Microphone.",
        });
      },
    };
  }
  return {
    prepare: async ({ signal }) => {
      throwIfVoiceTranscriptionAborted(signal);
      return {
        locale,
        transcribe: async (uri, options) => {
          throwIfVoiceTranscriptionAborted(options.signal);
          // Expo's fetch takes an expo-file-system File as the part, not {uri, name, type}.
          const file = new File(uri);
          const body = new FormData();
          body.append("response_format", "json");
          body.append("file", file, file.name || "dictation.m4a");
          const timeout = AbortSignal.timeout(UPLOAD_TIMEOUT_MS);
          let response: Response;
          try {
            response = await fetch(`${speech}/v1/audio/transcriptions`, {
              method: "POST",
              headers: { Authorization: `Bearer ${token}` },
              body,
              signal: AbortSignal.any([options.signal, timeout]),
            });
          } catch (cause) {
            throwIfVoiceTranscriptionAborted(options.signal);
            throw new VoiceTranscriptionError({
              code: "transcription-failed",
              message: `Cannot reach the Operator server at ${hostOf(speech)}.`,
              cause,
            });
          }
          if (!response.ok) {
            throw new VoiceTranscriptionError({
              code: "transcription-failed",
              message: await failureMessage(response),
            });
          }
          const json = (await response.json()) as { readonly text?: unknown };
          throwIfVoiceTranscriptionAborted(options.signal);
          return text(json.text).trim();
        },
      };
    },
  };
}

async function failureMessage(response: Response): Promise<string> {
  if (response.status === 401 || response.status === 403) {
    return "Your Operator sign-in has ended. Sign in again in Settings › Microphone.";
  }
  try {
    const json = (await response.json()) as { readonly error?: { readonly message?: unknown } };
    if (typeof json.error?.message === "string") return `Operator: ${json.error.message}`;
  } catch {
    // Not JSON; fall through.
  }
  return `The Operator server answered ${response.status}.`;
}

function hostOf(base: string): string {
  try {
    return new URL(base).host;
  } catch {
    return base;
  }
}
