import type { DesktopOrbitToolRequest, EnvironmentId } from "@t3tools/contracts";
import { describe, expect, it, vi } from "vite-plus/test";

import { chooseOrbitToolTransport, createDesktopOrbitTransport } from "./desktopOrbitTransport";
import { OrbitTransportError } from "./orbitTransport";

const environmentId = "env-clone" as EnvironmentId;

function sender(answer: { error: string | null; status: number; body: string }) {
  return vi.fn(async (_request: DesktopOrbitToolRequest) => answer);
}

describe("createDesktopOrbitTransport", () => {
  it("sends the request with the environment, a JSON body and the timeout in ms", async () => {
    const send = sender({ error: null, status: 201, body: '{"data":{"id":"s1"}}' });
    const transport = createDesktopOrbitTransport({ environmentId, send });
    const response = await transport({
      method: "POST",
      path: "/api/v1/instances/12/log-streams",
      body: { socket_id: "1.2", lines: 200 },
      timeoutSeconds: 30,
    });
    expect(send).toHaveBeenCalledWith({
      environmentId,
      method: "POST",
      path: "/api/v1/instances/12/log-streams",
      query: {},
      body: '{"socket_id":"1.2","lines":200}',
      timeoutMs: 30_000,
    });
    expect(response).toEqual({ status: 201, body: { data: { id: "s1" } } });
  });

  it("defaults to 60 s with no body, and keeps a non-JSON body as text", async () => {
    const send = sender({ error: null, status: 502, body: "Bad Gateway" });
    const transport = createDesktopOrbitTransport({ environmentId, send });
    const response = await transport({ method: "GET", path: "/api/v1/nodes" });
    expect(send.mock.calls[0]![0]).toMatchObject({ body: null, timeoutMs: 60_000 });
    expect(response).toEqual({ status: 502, body: "Bad Gateway" });
  });

  it("turns a refusal or a lost answer into a transport error", async () => {
    const transport = createDesktopOrbitTransport({
      environmentId,
      send: sender({ error: "That Gateway path is not allowed.", status: 0, body: "" }),
    });
    await expect(transport({ method: "GET", path: "/api/v1/conn/me" })).rejects.toEqual(
      new OrbitTransportError({ message: "That Gateway path is not allowed." }),
    );
  });
});

describe("chooseOrbitToolTransport", () => {
  const base = { environmentId, cwd: "/srv/workspace" };

  it("uses the desktop for an environment in an Orbit Instance", () => {
    const send = sender({ error: null, status: 200, body: "" });
    expect(chooseOrbitToolTransport({ ...base, orbitInstanceId: 12, send }).kind).toBe("desktop");
  });

  it("keeps the terminal without an Orbit Instance or without the desktop method", () => {
    const send = sender({ error: null, status: 200, body: "" });
    expect(chooseOrbitToolTransport({ ...base, orbitInstanceId: null, send }).kind).toBe(
      "terminal",
    );
    expect(chooseOrbitToolTransport({ ...base, orbitInstanceId: 12, send: undefined }).kind).toBe(
      "terminal",
    );
  });
});
