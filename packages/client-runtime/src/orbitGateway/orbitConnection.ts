import * as Schema from "effect/Schema";

import {
  OrbitGatewayError,
  gatewayText,
  type OrbitGatewayEnvironment,
  type OrbitGatewayNode,
} from "./client.ts";

/**
 * Conn: the Orbit panel's Connection page, shared by desktop and mobile. Conn picks up the Orbit
 * connection from the machine, so each failed check says what to fix outside Conn.
 */
export type OrbitConnectionCheckKey = "gateway" | "certificate" | "device";
export type OrbitConnectionCheckState = "pass" | "fail" | "checking" | "not_checked";

export interface OrbitConnectionCheck {
  readonly key: OrbitConnectionCheckKey;
  readonly label: string;
  readonly state: OrbitConnectionCheckState;
  readonly message: string;
}

/** The result of the Gateway's `me` call, which runs all three checks at once. */
export type OrbitConnectionProbe =
  | { readonly status: "checking" }
  | { readonly status: "ok"; readonly node: OrbitGatewayNode }
  | { readonly status: "error"; readonly error: unknown };

const LABELS: Record<OrbitConnectionCheckKey, string> = {
  gateway: "Gateway reachable",
  certificate: "Certificate trusted",
  device: "Device known",
};

const PASSED: Record<Exclude<OrbitConnectionCheckKey, "device">, string> = {
  gateway: "gateway.orbit answers over WireGuard.",
  certificate: "The Orbit root CA is trusted on this device.",
};

/** Why the checks after a failed one did not run. */
const NOT_CHECKED: Record<Exclude<OrbitConnectionCheckKey, "device">, string> = {
  gateway: "Not checked: the Gateway does not answer.",
  certificate: "Not checked: the Gateway's certificate is not trusted.",
};

const PEER_IDENTITY_UNKNOWN = "peer.identity_unknown";
const NODE_ACCESS_REQUIRED = "node_access.required";

const isGatewayError = Schema.is(OrbitGatewayError);

/**
 * Chromium's TLS failures (`net::ERR_CERT_AUTHORITY_INVALID`, `net::ERR_SSL_PROTOCOL_ERROR`, …)
 * reach Conn inside the transport's message; a refused, unresolved or timed-out connection does not
 * name a certificate.
 */
function isCertificateFailure(message: string): boolean {
  return /\bnet::ERR_(CERT_|SSL_|BAD_SSL_)/.test(message);
}

/** Which check the error fails; earlier checks pass, later ones are not checked. */
function failedCheck(error: unknown): { key: OrbitConnectionCheckKey; message: string } {
  if (!isGatewayError(error) || error.code === "gateway.unreachable") {
    const text = error instanceof Error ? error.message : String(error);
    if (!isCertificateFailure(text)) {
      return {
        key: "gateway",
        message:
          "gateway.orbit does not answer. Check that the WireGuard tunnel to Orbit is up, then Reload.",
      };
    }
    return {
      key: "certificate",
      message: /\bnet::ERR_CERT_AUTHORITY_INVALID\b/.test(text)
        ? "The Orbit root CA is not trusted on this device. Add it to the keychain with the Orbit CLI, then Reload."
        : `gateway.orbit's certificate is not valid (${text.match(/net::ERR_[A-Z_]+/)?.[0]}). Check the certificate and this device's clock, then Reload.`,
    };
  }
  if (error.code === PEER_IDENTITY_UNKNOWN) {
    return {
      key: "device",
      message:
        "Orbit does not know this WireGuard address as an active Node. Add this device as a Node with the Orbit CLI, then Reload.",
    };
  }
  if (error.code === NODE_ACCESS_REQUIRED) {
    return {
      key: "device",
      message:
        "This Node has no access to the Gateway. Give it access with the Orbit CLI, then Reload.",
    };
  }
  // The Gateway answered over trusted TLS but could not say who this device is.
  return {
    key: "device",
    message: `The Gateway could not confirm this device: ${error.message} Reload to try again.`,
  };
}

const ORDER: readonly OrbitConnectionCheckKey[] = ["gateway", "certificate", "device"];

/** The three checks for one `me` result, in order. */
export function orbitConnectionChecks(probe: OrbitConnectionProbe): OrbitConnectionCheck[] {
  const check = (
    key: OrbitConnectionCheckKey,
    state: OrbitConnectionCheckState,
    message: string,
  ): OrbitConnectionCheck => ({ key, label: LABELS[key], state, message });

  if (probe.status === "checking") {
    return ORDER.map((key) => check(key, "checking", "Checking…"));
  }
  if (probe.status === "ok") {
    return [
      check("gateway", "pass", PASSED.gateway),
      check("certificate", "pass", PASSED.certificate),
      check("device", "pass", `Orbit knows this WireGuard address as the Node ${probe.node.name}.`),
    ];
  }
  const failed = failedCheck(probe.error);
  const failedAt = ORDER.indexOf(failed.key);
  return ORDER.map((key, index) => {
    if (index < failedAt) return check(key, "pass", PASSED[key as keyof typeof PASSED]);
    if (index === failedAt) return check(key, "fail", failed.message);
    return check(key, "not_checked", NOT_CHECKED[failed.key as keyof typeof NOT_CHECKED]);
  });
}

export type OrbitNodeState = "paired" | "pairing" | "expired";

export interface OrbitNodeServer {
  readonly environmentId: string;
  readonly name: string;
  readonly address: string;
  readonly state: OrbitNodeState;
  readonly isThisDevice: boolean;
}

/** The host part of a server URL; a URL that does not parse keeps its text without scheme or path. */
function addressOf(url: string): string {
  try {
    return new URL(url).hostname.replace(/^\[(.*)\]$/, "$1");
  } catch {
    return url.replace(/^[a-z]+:\/\//i, "").replace(/[/:].*$/, "");
  }
}

/**
 * The Nodes that run a T3 server: the Gateway's host servers. An Instance's server (any server
 * with an Instance, Project or Instance URL) is never listed; it belongs to the Instances page.
 */
export function orbitNodeServers(input: {
  readonly environments: readonly OrbitGatewayEnvironment[];
  /** Environment ids this device has paired. */
  readonly paired: ReadonlySet<string>;
  readonly device: Pick<OrbitGatewayNode, "name" | "wireguardIp"> | null;
}): OrbitNodeServer[] {
  const seen = new Set<string>();
  const nodes: OrbitNodeServer[] = [];
  for (const environment of input.environments) {
    if (
      environment.instanceId !== null ||
      environment.projectId !== null ||
      environment.instanceUrl !== null ||
      seen.has(environment.environmentId)
    ) {
      continue;
    }
    seen.add(environment.environmentId);
    const address = addressOf(environment.url);
    const name = gatewayText(environment.nodeName) ?? gatewayText(environment.label) ?? address;
    nodes.push({
      environmentId: environment.environmentId,
      name,
      address,
      state:
        environment.status === "session_expired"
          ? "expired"
          : input.paired.has(environment.environmentId)
            ? "paired"
            : "pairing",
      isThisDevice:
        input.device !== null &&
        (address === input.device.wireguardIp ||
          gatewayText(environment.nodeName) === input.device.name),
    });
  }
  return nodes.sort(
    (a, b) => Number(b.isThisDevice) - Number(a.isThisDevice) || a.name.localeCompare(b.name),
  );
}
