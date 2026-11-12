import { describe, expect, it } from "vite-plus/test";

import {
  createOrbitGatewayClient,
  type OrbitGatewayEnvironment,
  type OrbitGatewayResponse,
} from "./client.ts";
import { orbitConnectionChecks, orbitNodeServers } from "./orbitConnection.ts";

/** The error `me` throws when the desktop transport fails or the Gateway answers `response`. */
async function meError(failure: { transport: string } | OrbitGatewayResponse): Promise<unknown> {
  const client = createOrbitGatewayClient(async () => {
    if ("transport" in failure) throw new Error(failure.transport);
    return failure;
  });
  return client.me().then(
    () => {
      throw new Error("me() should fail");
    },
    (error: unknown) => error,
  );
}

const gatewayError = (status: number, code: string, message = "Refused.") => ({
  status,
  body: JSON.stringify({ status, error: { code, message, details: {} } }),
});

const states = (checks: ReturnType<typeof orbitConnectionChecks>) =>
  checks.map((check) => `${check.key}:${check.state}`);

describe("orbitConnectionChecks", () => {
  it("passes all three when the Gateway names this device", () => {
    const checks = orbitConnectionChecks({
      status: "ok",
      node: { id: 45, name: "nick", wireguardIp: "10.44.0.12", profile: null },
    });
    expect(states(checks)).toEqual(["gateway:pass", "certificate:pass", "device:pass"]);
    expect(checks[2]!.message).toBe("Orbit knows this WireGuard address as the Node nick.");
  });

  it("shows all three as checking while `me` runs", () => {
    expect(states(orbitConnectionChecks({ status: "checking" }))).toEqual([
      "gateway:checking",
      "certificate:checking",
      "device:checking",
    ]);
  });

  it.each([
    // Electron's net.fetch messages, as the desktop transport passes them on.
    ["refused", { transport: "net::ERR_CONNECTION_REFUSED" }, "gateway"],
    ["unresolved", { transport: "net::ERR_NAME_NOT_RESOLVED" }, "gateway"],
    ["timed out", { transport: "The Orbit Gateway did not answer in time." }, "gateway"],
    ["untrusted CA", { transport: "net::ERR_CERT_AUTHORITY_INVALID" }, "certificate"],
    ["TLS failure", { transport: "net::ERR_SSL_PROTOCOL_ERROR" }, "certificate"],
    ["unknown peer", gatewayError(403, "peer.identity_unknown"), "device"],
    ["no node access", gatewayError(403, "node_access.required"), "device"],
    ["server error", gatewayError(500, "server.error", "Boom."), "device"],
    ["garbled reply", { status: 200, body: "<html>" }, "device"],
  ] as const)("maps %s to a failed %s check", async (_name, failure, failed) => {
    const checks = orbitConnectionChecks({ status: "error", error: await meError(failure) });
    const order = ["gateway", "certificate", "device"];
    const at = order.indexOf(failed);
    expect(states(checks)).toEqual(
      order.map(
        (key, index) => `${key}:${index < at ? "pass" : index === at ? "fail" : "not_checked"}`,
      ),
    );
    expect(checks[at]!.message).toMatch(/Reload/);
  });

  it("says why a check after a failure did not run", async () => {
    const checks = orbitConnectionChecks({
      status: "error",
      error: await meError({ transport: "net::ERR_CONNECTION_REFUSED" }),
    });
    expect(checks.map((check) => check.message)).toEqual([
      "gateway.orbit does not answer. Check that the WireGuard tunnel to Orbit is up, then Reload.",
      "Not checked: the Gateway does not answer.",
      "Not checked: the Gateway does not answer.",
    ]);
    const certificate = orbitConnectionChecks({
      status: "error",
      error: await meError({ transport: "net::ERR_CERT_AUTHORITY_INVALID" }),
    });
    expect(certificate[2]!.message).toBe("Not checked: the Gateway's certificate is not trusted.");
  });

  it("names the certificate error that is not an untrusted CA", async () => {
    const [untrusted, expired] = await Promise.all([
      meError({ transport: "net::ERR_CERT_AUTHORITY_INVALID" }),
      meError({ transport: "net::ERR_CERT_DATE_INVALID" }),
    ]);
    expect(orbitConnectionChecks({ status: "error", error: untrusted })[1]!.message).toMatch(
      /root CA is not trusted/,
    );
    expect(orbitConnectionChecks({ status: "error", error: expired })[1]!.message).toBe(
      "gateway.orbit's certificate is not valid (net::ERR_CERT_DATE_INVALID). Check the certificate and this device's clock, then Reload.",
    );
  });

  it("tells an unknown peer from a Node without access", async () => {
    const [unknown, noAccess] = await Promise.all([
      meError(gatewayError(403, "peer.identity_unknown")),
      meError(gatewayError(403, "node_access.required")),
    ]);
    expect(orbitConnectionChecks({ status: "error", error: unknown })[2]!.message).toMatch(
      /not know this WireGuard address/,
    );
    expect(orbitConnectionChecks({ status: "error", error: noAccess })[2]!.message).toMatch(
      /no access to the Gateway/,
    );
  });
});

const server = (
  environmentId: string,
  patch: Partial<OrbitGatewayEnvironment> = {},
): OrbitGatewayEnvironment => ({
  environmentId,
  label: environmentId,
  url: "http://10.44.0.3:3773",
  serverVersion: null,
  registeredBy: null,
  registeredAt: null,
  status: "registered",
  instanceId: null,
  powerState: null,
  projectId: null,
  projectName: null,
  projectSlug: null,
  instanceName: null,
  nodeName: null,
  instanceUrl: null,
  ...patch,
});

describe("orbitNodeServers", () => {
  it("lists host servers only, this device first, with their state", () => {
    const nodes = orbitNodeServers({
      environments: [
        server("mini", { url: "http://10.44.0.3:3773" }),
        server("clone", { instanceId: 7, url: "http://10.44.0.3:4100" }),
        server("project-clone", { projectId: 2 }),
        server("routed-clone", { instanceUrl: "https://x.orbit" }),
        server("beast", { url: "http://10.44.0.2:3773", status: "session_expired" }),
        server("nick", { url: "http://10.44.0.12:3773" }),
        server("mini", { url: "http://10.44.0.3:3773" }),
      ],
      paired: new Set(["mini", "nick"]),
      device: { name: "nick", wireguardIp: "10.44.0.12" },
    });
    expect(nodes).toEqual([
      {
        environmentId: "nick",
        name: "nick",
        address: "10.44.0.12",
        state: "paired",
        isThisDevice: true,
      },
      {
        environmentId: "beast",
        name: "beast",
        address: "10.44.0.2",
        state: "expired",
        isThisDevice: false,
      },
      {
        environmentId: "mini",
        name: "mini",
        address: "10.44.0.3",
        state: "paired",
        isThisDevice: false,
      },
    ]);
  });

  it("tolerates an empty label and a URL that does not parse", () => {
    const [node] = orbitNodeServers({
      environments: [server("odd", { label: "  ", url: "10.44.0.9:3773/path" })],
      paired: new Set(),
      device: null,
    });
    expect(node).toMatchObject({ name: "10.44.0.9", address: "10.44.0.9", state: "pairing" });
  });

  it("prefers the Gateway's Node name and reads IPv6 addresses", () => {
    const [node] = orbitNodeServers({
      environments: [
        server("id", { label: "t3", nodeName: "shark", url: "http://[fd00::9]:3773" }),
      ],
      paired: new Set(),
      device: null,
    });
    expect(node).toMatchObject({ name: "shark", address: "fd00::9" });
  });
});
