import { type EnvironmentId, ThreadId } from "@t3tools/contracts";
import { runAtomCommand } from "@t3tools/client-runtime/state/runtime";
import { terminalOutputText } from "@t3tools/client-runtime/state/terminal";
import * as Option from "effect/Option";
import { AsyncResult } from "effect/reactivity";

import { randomUUID } from "../lib/utils";
import { appAtomRegistry } from "../rpc/atomRegistry";
import { terminalEnvironment } from "../state/terminal";

/**
 * Orbit identifies callers by their WireGuard address, so every Orbit call
 * must run on the Node that hosts the T3 environment. The upstream T3 server
 * has no command RPC, so calls (and the git commands that prepare a worktree)
 * run as short scripts in a hidden terminal on that machine; the result comes
 * back between markers in the terminal output.
 */

export const DEFAULT_ORBIT_GATEWAY_URL = "https://gateway.orbit";
const GATEWAY_URL_STORAGE_KEY = "t3code:orbit-gateway-url";
const ORBIT_CONTROL_THREAD_ID = ThreadId.make("orbit-control");

export interface OrbitHttpRequest {
  readonly method: "GET" | "POST" | "PATCH" | "PUT" | "DELETE";
  readonly path: string;
  readonly query?: Readonly<Record<string, string>>;
  readonly body?: unknown;
  readonly timeoutSeconds?: number;
}

export interface OrbitHttpResponse {
  readonly status: number;
  readonly body: unknown;
}

export type OrbitTransport = (request: OrbitHttpRequest) => Promise<OrbitHttpResponse>;

export class OrbitTransportError extends Error {
  override readonly name = "OrbitTransportError";
}

export function readOrbitGatewayUrl(): string {
  try {
    const stored = globalThis.localStorage?.getItem(GATEWAY_URL_STORAGE_KEY)?.trim();
    if (stored) return stored.replace(/\/+$/, "");
  } catch {
    // Storage can be unavailable; the default Gateway applies.
  }
  return DEFAULT_ORBIT_GATEWAY_URL;
}

function encodeBase64(text: string): string {
  const bytes = new TextEncoder().encode(text);
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function decodeBase64(encoded: string): string {
  const binary = atob(encoded);
  const bytes = Uint8Array.from(binary, (char) => char.charCodeAt(0));
  return new TextDecoder().decode(bytes);
}

export function buildOrbitRequestUrl(gatewayUrl: string, request: OrbitHttpRequest): string {
  const url = new URL(request.path, `${gatewayUrl}/`);
  for (const [key, value] of Object.entries(request.query ?? {})) {
    url.searchParams.set(key, value);
  }
  return url.toString();
}

/** Quote a value for a POSIX shell script. */
export function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}

/**
 * One line for an interactive shell that runs `script` with `sh` and prints
 * `<exit code>\n<combined output>` as base64 between two markers. The script
 * travels base64-encoded, so no quoting can break the line, and the markers
 * are assembled at run time, so the echoed line never contains a complete
 * marker. The leading space keeps the line out of shells that ignore such history.
 */
export function buildHiddenShellLine(input: {
  readonly requestId: string;
  readonly script: string;
}): string {
  if (!/^[A-Za-z0-9-]+$/.test(input.requestId)) {
    throw new OrbitTransportError("Invalid request id.");
  }
  const marker = (part: "BEGIN" | "END") =>
    `printf '\\n__T3ORBIT_%s_%s__\\n' ${input.requestId} ${part}`;
  const wrapped = [
    `r=$( { ${input.script}\n} 2>&1 )`,
    "c=$?",
    marker("BEGIN"),
    `printf '%s\\n%s' "$c" "$r" | base64 | tr -d '\\n'`,
    marker("END"),
  ].join("\n");
  return ` sh -c "$(printf %s ${encodeBase64(wrapped)} | base64 -d)"; exit\r`;
}

export type HiddenShellOutput =
  | { readonly _tag: "pending" }
  | { readonly _tag: "done"; readonly exitCode: number; readonly output: string }
  | { readonly _tag: "failed"; readonly message: string };

export function parseHiddenShellOutput(output: string, requestId: string): HiddenShellOutput {
  const begin = `__T3ORBIT_${requestId}_BEGIN__`;
  const end = `__T3ORBIT_${requestId}_END__`;
  const beginIndex = output.indexOf(begin);
  if (beginIndex === -1) return { _tag: "pending" };
  const endIndex = output.indexOf(end, beginIndex + begin.length);
  if (endIndex === -1) return { _tag: "pending" };
  const encoded = output.slice(beginIndex + begin.length, endIndex).replace(/\s+/g, "");
  let decoded: string;
  try {
    decoded = decodeBase64(encoded);
  } catch {
    return { _tag: "failed", message: "Could not read the shell output." };
  }
  const firstNewline = decoded.indexOf("\n");
  const exitCode = Number(firstNewline === -1 ? decoded : decoded.slice(0, firstNewline));
  return {
    _tag: "done",
    exitCode: Number.isInteger(exitCode) ? exitCode : -1,
    output: firstNewline === -1 ? "" : decoded.slice(firstNewline + 1),
  };
}

/** A `curl` script that prints `<body>\n<http status>`. */
export function buildOrbitCurlScript(url: string, request: OrbitHttpRequest): string {
  const timeout = Math.max(1, Math.round(request.timeoutSeconds ?? 60));
  const curl = [
    '"$k" -sS',
    `--max-time ${timeout}`,
    `-X ${request.method}`,
    "-H 'accept: application/json'",
    ...(request.body === undefined
      ? []
      : ["-H 'content-type: application/json'", "--data-binary @-"]),
    `-w '\\n%{http_code}'`,
    shellQuote(url),
  ].join(" ");
  return [
    // The system curl trusts the system CA store, where Orbit installs its root
    // CA; a shell PATH can put another curl (e.g. Homebrew's) first.
    'k=/usr/bin/curl; [ -x "$k" ] || k=curl',
    request.body === undefined
      ? `${curl} </dev/null`
      : `printf %s ${encodeBase64(JSON.stringify(request.body))} | base64 -d | ${curl}`,
  ].join("\n");
}

export function parseOrbitCurlOutput(exitCode: number, output: string): OrbitHttpResponse {
  const lastNewline = output.lastIndexOf("\n");
  const statusText = lastNewline === -1 ? output : output.slice(lastNewline + 1);
  const bodyText = lastNewline === -1 ? "" : output.slice(0, lastNewline);
  if (exitCode !== 0) {
    const detail = (bodyText || statusText).trim().split("\n").at(-1) ?? "";
    throw new OrbitTransportError(
      `Orbit is not reachable from this machine${detail ? `: ${detail}` : "."}`,
    );
  }
  const status = Number(statusText.trim());
  if (!Number.isInteger(status) || status <= 0) {
    throw new OrbitTransportError("Orbit returned no HTTP status.");
  }
  let body: unknown = null;
  if (bodyText.trim() !== "") {
    try {
      body = JSON.parse(bodyText);
    } catch {
      body = bodyText;
    }
  }
  return { status, body };
}

function waitForShellResult(input: {
  readonly environmentId: EnvironmentId;
  readonly terminalId: string;
  readonly cwd: string;
  readonly requestId: string;
  readonly timeoutMs: number;
}): {
  readonly promise: Promise<{ readonly exitCode: number; readonly output: string }>;
  readonly cancel: () => void;
} {
  const attachAtom = terminalEnvironment.attach({
    environmentId: input.environmentId,
    input: { threadId: ORBIT_CONTROL_THREAD_ID, terminalId: input.terminalId, cwd: input.cwd },
  });
  let unsubscribe: (() => void) | null = null;
  let timeoutId: ReturnType<typeof globalThis.setTimeout> | null = null;
  const cancel = () => {
    unsubscribe?.();
    unsubscribe = null;
    if (timeoutId !== null) globalThis.clearTimeout(timeoutId);
    timeoutId = null;
  };
  const promise = new Promise<{ readonly exitCode: number; readonly output: string }>(
    (resolve, reject) => {
      const inspect = (result: AsyncResult.AsyncResult<unknown, unknown>) => {
        const state = Option.getOrNull(AsyncResult.value(result)) as {
          readonly output: Parameters<typeof terminalOutputText>[0];
        } | null;
        if (state === null) return;
        const parsed = parseHiddenShellOutput(terminalOutputText(state.output), input.requestId);
        if (parsed._tag === "pending") return;
        cancel();
        if (parsed._tag === "done") resolve(parsed);
        else reject(new OrbitTransportError(parsed.message));
      };
      timeoutId = globalThis.setTimeout(() => {
        cancel();
        reject(new OrbitTransportError("The command on this machine did not finish in time."));
      }, input.timeoutMs);
      unsubscribe = appAtomRegistry.subscribe(attachAtom, inspect, { immediate: true });
    },
  );
  return { promise, cancel };
}

/**
 * Run a short `sh` script on the machine of one T3 environment, in a hidden
 * terminal, and return its exit code and combined output.
 */
export async function runHiddenShell(input: {
  readonly environmentId: EnvironmentId;
  /** An existing directory on that machine, e.g. the project root. */
  readonly cwd: string;
  readonly script: string;
  readonly timeoutSeconds: number;
}): Promise<{ readonly exitCode: number; readonly output: string }> {
  const requestId = randomUUID()
    .replace(/[^A-Za-z0-9]/g, "")
    .slice(0, 16);
  const terminalId = `orbit-${requestId}`;
  const line = buildHiddenShellLine({ requestId, script: input.script });
  const target = { threadId: ORBIT_CONTROL_THREAD_ID, terminalId };
  const opened = await runAtomCommand(
    appAtomRegistry,
    terminalEnvironment.open,
    { environmentId: input.environmentId, input: { ...target, cwd: input.cwd } },
    { reportFailure: false },
  );
  if (opened._tag !== "Success") {
    throw new OrbitTransportError("Could not open a shell on this machine.");
  }
  const waiting = waitForShellResult({
    environmentId: input.environmentId,
    terminalId,
    cwd: input.cwd,
    requestId,
    timeoutMs: (input.timeoutSeconds + 30) * 1000,
  });
  try {
    const wrote = await runAtomCommand(
      appAtomRegistry,
      terminalEnvironment.write,
      { environmentId: input.environmentId, input: { ...target, data: line } },
      { reportFailure: false },
    );
    if (wrote._tag !== "Success") {
      throw new OrbitTransportError("Could not run the command on this machine.");
    }
    return await waiting.promise;
  } finally {
    waiting.cancel();
    void runAtomCommand(
      appAtomRegistry,
      terminalEnvironment.close,
      { environmentId: input.environmentId, input: { ...target, deleteHistory: true } },
      { reportFailure: false },
    );
  }
}

/** A transport that runs Orbit calls on the machine of one T3 environment. */
export function createTerminalOrbitTransport(input: {
  readonly environmentId: EnvironmentId;
  /** An existing directory on that machine, e.g. the project root. */
  readonly cwd: string;
}): OrbitTransport {
  return async (request) => {
    const timeoutSeconds = request.timeoutSeconds ?? 60;
    const result = await runHiddenShell({
      environmentId: input.environmentId,
      cwd: input.cwd,
      script: buildOrbitCurlScript(buildOrbitRequestUrl(readOrbitGatewayUrl(), request), request),
      timeoutSeconds,
    });
    return parseOrbitCurlOutput(result.exitCode, result.output);
  };
}
