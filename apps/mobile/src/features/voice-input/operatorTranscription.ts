import { File } from "expo-file-system";
import * as SecureStore from "expo-secure-store";

import {
  VoiceTranscriptionError,
  throwIfVoiceTranscriptionAborted,
  type VoiceTranscriber,
} from "@t3tools/client-runtime/voice-input";

/**
 * Conn: voice input can send recordings to an Operator server (nckrtl/operator) instead of the
 * on-device recognizer. The server takes the recorder's M4A as is at its OpenAI-style
 * `/v1/audio/transcriptions`, with a client token as `Authorization: Bearer`.
 */

export type VoiceTranscriptionEngine = "device" | "operator";

export interface OperatorTranscriptionSettings {
  readonly engine: VoiceTranscriptionEngine;
  /** "host:port, host:port", tried in order, as in the Operator iOS app. */
  readonly addresses: string;
  readonly token: string;
  readonly loaded: boolean;
}

const STORAGE_KEY = "conn.voice-transcription.v1";
const REQUEST_TIMEOUT_MS = 15_000;
const UPLOAD_TIMEOUT_MS = 120_000;

let settings: OperatorTranscriptionSettings = {
  engine: "device",
  addresses: "",
  token: "",
  loaded: false,
};
const listeners = new Set<() => void>();
/** The address that answered last; tried first next time. */
let preferredBase: string | null = null;

function publish(next: OperatorTranscriptionSettings): void {
  settings = next;
  for (const listener of listeners) listener();
}

let loading: Promise<void> | null = null;
export function loadOperatorTranscriptionSettings(): Promise<void> {
  loading ??= SecureStore.getItemAsync(STORAGE_KEY)
    .then((raw) => {
      const parsed = raw === null ? {} : (JSON.parse(raw) as Record<string, unknown>);
      publish({
        engine: parsed.engine === "operator" ? "operator" : "device",
        addresses: typeof parsed.addresses === "string" ? parsed.addresses : "",
        token: typeof parsed.token === "string" ? parsed.token : "",
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
  const next = { ...settings, ...patch };
  if (patch.addresses !== undefined) preferredBase = null;
  publish(next);
  await SecureStore.setItemAsync(
    STORAGE_KEY,
    JSON.stringify({ engine: next.engine, addresses: next.addresses, token: next.token }),
  );
}

export function getOperatorTranscriptionSettings(): OperatorTranscriptionSettings {
  return settings;
}

export function subscribeOperatorTranscriptionSettings(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function operatorServerBases(addresses: string): string[] {
  return addresses
    .split(",")
    .map((part) => part.trim())
    .filter((part) => part.length > 0)
    .map((part) => (part.includes("://") ? part : `http://${part}`).replace(/\/+$/, ""));
}

function operatorServer(current: OperatorTranscriptionSettings) {
  const bases = operatorServerBases(current.addresses);
  const token = current.token.trim();
  return bases.length === 0 || token.length === 0 ? null : { bases, token };
}

export function getOperatorVoiceTranscriber(locale: string): VoiceTranscriber {
  const server = operatorServer(settings);
  if (!server) {
    return {
      prepare: async () => {
        throw new VoiceTranscriptionError(
          "server-failed",
          "Set the Operator server address and token in Settings › Microphone.",
        );
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
          const file = new File(uri);
          const response = await send(
            server,
            "v1/audio/transcriptions",
            () => {
              // Expo's fetch takes an expo-file-system File as the part, not {uri, name, type}.
              const body = new FormData();
              body.append("response_format", "json");
              body.append("file", file, file.name || "dictation.m4a");
              return { method: "POST", body };
            },
            UPLOAD_TIMEOUT_MS,
            options.signal,
          );
          const json = (await response.json()) as { readonly text?: unknown };
          throwIfVoiceTranscriptionAborted(options.signal);
          return typeof json.text === "string" ? json.text.trim() : "";
        },
      };
    },
  };
}

/** Checks the address and token with `GET /v1/models`, which needs a valid client token. */
export async function testOperatorServer(addresses: string, token: string): Promise<void> {
  const server = operatorServer({ engine: "operator", addresses, token, loaded: true });
  if (!server) throw new Error("Enter an address and a token.");
  await send(server, "v1/models", () => ({ method: "GET" }), REQUEST_TIMEOUT_MS);
}

async function send(
  server: { readonly bases: readonly string[]; readonly token: string },
  path: string,
  init: () => RequestInit,
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<Response> {
  const ordered = [...server.bases];
  const preferredIndex = preferredBase === null ? -1 : ordered.indexOf(preferredBase);
  if (preferredIndex > 0) ordered.unshift(...ordered.splice(preferredIndex, 1));

  let lastMessage = "No Operator server address.";
  for (const base of ordered) {
    if (signal) throwIfVoiceTranscriptionAborted(signal);
    const timeout = AbortSignal.timeout(timeoutMs);
    let response: Response;
    try {
      response = await fetch(`${base}/${path}`, {
        ...init(),
        headers: { Authorization: `Bearer ${server.token}` },
        signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
      });
    } catch (cause) {
      if (signal) throwIfVoiceTranscriptionAborted(signal);
      lastMessage = `Cannot reach the Operator server at ${hostOf(base)}.`;
      if (ordered.length === 1) {
        throw new VoiceTranscriptionError("server-failed", lastMessage, { cause });
      }
      continue;
    }
    preferredBase = base;
    if (response.ok) return response;
    throw new VoiceTranscriptionError("server-failed", await failureMessage(response));
  }
  throw new VoiceTranscriptionError("server-failed", lastMessage);
}

async function failureMessage(response: Response): Promise<string> {
  if (response.status === 401 || response.status === 403) {
    return "The Operator server rejected the token. Check the token in Settings › Microphone › Transcription.";
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
