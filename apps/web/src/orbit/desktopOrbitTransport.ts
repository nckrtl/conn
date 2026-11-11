import type { DesktopBridge, EnvironmentId } from "@t3tools/contracts";

import {
  createTerminalOrbitTransport,
  type OrbitTransport,
  OrbitTransportError,
} from "./orbitTransport";

type OrbitToolSend = NonNullable<DesktopBridge["orbitToolSend"]>;

/**
 * The Orbit tool's transport for a thread in an Orbit Instance: the desktop main process calls
 * the Gateway, because the Node's proxy refuses `.orbit` names from the container. The main
 * process allows only the tool's calls, and writes only to the environment's own Instance.
 */
export function createDesktopOrbitTransport(input: {
  readonly environmentId: EnvironmentId;
  readonly send: OrbitToolSend;
}): OrbitTransport {
  return async (request) => {
    if (request.method === "PATCH") {
      throw new OrbitTransportError({ message: "The Orbit tool sends no PATCH calls." });
    }
    const response = await input.send({
      environmentId: input.environmentId,
      method: request.method,
      path: request.path,
      query: request.query ?? {},
      body: request.body === undefined ? null : JSON.stringify(request.body),
      timeoutMs: Math.min(120_000, Math.max(1_000, (request.timeoutSeconds ?? 60) * 1000)),
    });
    if (response.error !== null) throw new OrbitTransportError({ message: response.error });
    let body: unknown = null;
    if (response.body.trim() !== "") {
      try {
        body = JSON.parse(response.body);
      } catch {
        body = response.body;
      }
    }
    return { status: response.status, body };
  };
}

export type OrbitToolTransportKind = "desktop" | "terminal";

/** The desktop transport for an environment in an Orbit Instance, else the thread's terminal. */
export function chooseOrbitToolTransport(input: {
  readonly environmentId: EnvironmentId;
  readonly cwd: string;
  readonly orbitInstanceId: number | null;
  readonly send: OrbitToolSend | undefined;
}): { readonly kind: OrbitToolTransportKind; readonly transport: OrbitTransport } {
  if (input.orbitInstanceId !== null && input.send) {
    return {
      kind: "desktop",
      transport: createDesktopOrbitTransport({
        environmentId: input.environmentId,
        send: input.send,
      }),
    };
  }
  return {
    kind: "terminal",
    transport: createTerminalOrbitTransport({ environmentId: input.environmentId, cwd: input.cwd }),
  };
}
