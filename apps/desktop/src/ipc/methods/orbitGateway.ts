import * as Electron from "electron";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { DEFAULT_ORBIT_GATEWAY_URL } from "@t3tools/client-runtime/orbit-gateway";

import * as DesktopIpc from "../DesktopIpc.ts";
import { ORBIT_GATEWAY_SEND_CHANNEL } from "../channels.ts";

// Calls the Conn layer of the Orbit Gateway for the renderer's profile sync. It runs in the
// main process because the Gateway refuses requests that carry a page `Origin`, and Chromium's
// network stack trusts the Orbit root CA from the keychain. Only paths below /api/v1/conn are sent.

const TIMEOUT_MS = 15_000;
const CONN_PREFIX = "/api/v1/conn";

const OrbitGatewayRequest = Schema.Struct({
  method: Schema.Literals(["GET", "POST", "PUT", "PATCH"]),
  path: Schema.String.check(Schema.isPattern(/^\/[A-Za-z0-9/_.%-]{0,512}$/)),
  body: Schema.NullOr(Schema.String.check(Schema.isMaxLength(2_000_000))),
});

const OrbitGatewayResponse = Schema.Struct({
  error: Schema.NullOr(Schema.String),
  status: Schema.Int,
  body: Schema.String,
});

/**
 * Builds the Gateway URL for a Conn path, or returns null when the path would leave
 * `/api/v1/conn`. The path is resolved by the URL parser first, so `..` segments (also written
 * `%2e%2e`) cannot climb out of the prefix. They are rejected outright, as is an encoded slash.
 */
export function resolveConnUrl(path: string): URL | null {
  const segments = path.split("/");
  for (const segment of segments) {
    let decoded: string;
    try {
      decoded = decodeURIComponent(segment);
    } catch {
      return null;
    }
    if (decoded === "." || decoded === ".." || decoded.includes("/") || decoded.includes("\\")) {
      return null;
    }
  }
  let url: URL;
  try {
    url = new URL(`${DEFAULT_ORBIT_GATEWAY_URL}${CONN_PREFIX}${path}`);
  } catch {
    return null;
  }
  const inside = url.pathname === CONN_PREFIX || url.pathname.startsWith(`${CONN_PREFIX}/`);
  return inside && url.origin === new URL(DEFAULT_ORBIT_GATEWAY_URL).origin ? url : null;
}

async function send(
  request: typeof OrbitGatewayRequest.Type,
): Promise<typeof OrbitGatewayResponse.Type> {
  const url = resolveConnUrl(request.path);
  if (url === null) {
    return { error: "That Gateway path is not allowed.", status: 0, body: "" };
  }
  try {
    const response = await Electron.net.fetch(url.toString(), {
      method: request.method,
      headers: {
        Accept: "application/json",
        ...(request.body === null ? {} : { "Content-Type": "application/json" }),
      },
      body: request.body,
      signal: AbortSignal.timeout(TIMEOUT_MS),
      bypassCustomProtocolHandlers: true,
    });
    return { error: null, status: response.status, body: await response.text() };
  } catch (error) {
    return {
      error:
        error instanceof Error && error.name === "TimeoutError"
          ? "The Orbit Gateway did not answer in time."
          : error instanceof Error
            ? error.message
            : String(error),
      status: 0,
      body: "",
    };
  }
}

export const orbitGatewaySend = DesktopIpc.makeIpcMethod({
  channel: ORBIT_GATEWAY_SEND_CHANNEL,
  payload: OrbitGatewayRequest,
  result: OrbitGatewayResponse,
  handler: Effect.fn("desktop.ipc.orbitGateway.send")(function* (request) {
    return yield* Effect.promise(() => send(request));
  }),
});
