import { describe, expect, it } from "vite-plus/test";

import {
  createOrbitGatewayClient,
  type OrbitGatewayEnvironment,
  type OrbitGatewayResponse,
} from "./client.ts";
import { orbitConnectionChecks, orbitNodeServers, orbitSignedInText } from "./orbitConnection.ts";

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
    ["refused request", gatewayError(422, "request.invalid", "Bad."), "device"],
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

  it("does not blame the device when the Gateway answers with a server error", async () => {
    const checks = orbitConnectionChecks({
      status: "error",
      error: await meError(gatewayError(503, "server.unavailable", "Gateway is restarting.")),
    });
    expect(states(checks)).toEqual(["gateway:pass", "certificate:pass", "device:not_checked"]);
    expect(checks[2]!.message).toBe("Gateway is restarting.");

    const [bare, html] = await Promise.all([
      meError({ status: 500, body: JSON.stringify({ status: 500 }) }),
      meError({ status: 502, body: "<html>Bad Gateway</html>" }),
    ]);
    expect(states(orbitConnectionChecks({ status: "error", error: bare }))).toEqual([
      "gateway:pass",
      "certificate:pass",
      "device:not_checked",
    ]);
    expect(orbitConnectionChecks({ status: "error", error: bare })[2]!.message).toBe(
      "gateway.orbit answered with an error (HTTP 500). Try Reload later.",
    );
    expect(orbitConnectionChecks({ status: "error", error: html })[2]!.message).toBe(
      "gateway.orbit answered with an error (HTTP 502). Try Reload later.",
    );
  });

  it("shows nothing as checked when there is no Orbit client", () => {
    const checks = orbitConnectionChecks({ status: "unavailable" });
    expect(states(checks)).toEqual([
      "gateway:not_checked",
      "certificate:not_checked",
      "device:not_checked",
    ]);
  });

  it.each([
    ["empty", { wireguard_ip: "" }],
    ["blank", { wireguard_ip: "  " }],
    ["null", { wireguard_ip: null }],
    ["missing", {}],
  ])("fails the device check when `me` names no WireGuard address (%s)", async (_name, address) => {
    const client = createOrbitGatewayClient(async () => ({
      status: 200,
      body: JSON.stringify({ data: { id: 45, name: "nick", profile: null, ...address } }),
    }));
    const node = await client.me();
    const checks = orbitConnectionChecks({ status: "ok", node });
    expect(states(checks)).toEqual(["gateway:pass", "certificate:pass", "device:fail"]);
    expect(checks[2]!.message).toMatch(/not know this WireGuard address as an active Node/);
    // The other surfaces that show this device say the same, never "… as " with nothing after it.
    expect(orbitSignedInText(node)).toBe(checks[2]!.message);
    expect(orbitSignedInText({ wireguardIp: "10.44.0.12" })).toBe(
      "Signed in to gateway.orbit as 10.44.0.12",
    );
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
  it("shows a failed renewal with its reason, below an expired registration and a revoke", () => {
    const nodes = orbitNodeServers({
      environments: [
        server("beast", { url: "http://10.44.0.2:3773" }),
        server("mini", { url: "http://10.44.0.3:3773", status: "session_expired" }),
        server("shark", { url: "http://10.44.0.4:3773" }),
        server("nick", { url: "http://10.44.0.5:3773" }),
      ],
      paired: new Set(["beast", "mini", "shark", "nick"]),
      revoked: new Set(["shark"]),
      renewalFailed: new Map([
        ["beast", "orbit_unreachable"],
        ["mini", "session_ended"],
        ["shark", "unknown"],
      ]),
      device: null,
    });
    expect(nodes.map((node) => [node.name, node.state, node.renewalFailure])).toEqual([
      ["beast", "renewal_failed", "orbit_unreachable"],
      ["mini", "expired", null],
      ["nick", "paired", null],
      ["shark", "revoked", null],
    ]);
  });

  it("shows a server whose pairing Orbit revoked as revoked, even while it is saved", () => {
    const nodes = orbitNodeServers({
      environments: [server("beast", { url: "http://10.44.0.2:3773" })],
      paired: new Set(["beast"]),
      revoked: new Set(["beast"]),
      device: null,
    });
    expect(nodes.map((node) => node.state)).toEqual(["revoked"]);
  });

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
        renewalFailure: null,
        isThisDevice: true,
      },
      {
        environmentId: "beast",
        name: "beast",
        address: "10.44.0.2",
        state: "expired",
        renewalFailure: null,
        isThisDevice: false,
      },
      {
        environmentId: "mini",
        name: "mini",
        address: "10.44.0.3",
        state: "paired",
        renewalFailure: null,
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

  it("never matches this device by an empty address", () => {
    const [node] = orbitNodeServers({
      environments: [server("odd", { url: "" })],
      paired: new Set(),
      device: { name: "nick", wireguardIp: "" },
    });
    expect(node).toMatchObject({ address: "", isThisDevice: false });
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
