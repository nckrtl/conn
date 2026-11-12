import { OrbitGatewayError } from "@t3tools/client-runtime/orbit-gateway";
import { describe, expect, it } from "vite-plus/test";

import { phoneOrbitConnectionChecks } from "./orbitPhoneConnection";

const gatewayError = (code: string, message = "Gateway error.") =>
  new OrbitGatewayError({
    code,
    message,
    status: code === "gateway.unreachable" ? 0 : 403,
    details: {},
  });

const states = (checks: ReturnType<typeof phoneOrbitConnectionChecks>) =>
  checks.map((check) => [check.key, check.state]);

describe("phoneOrbitConnectionChecks", () => {
  it("fails the Gateway check with both causes when React Native's fetch fails", () => {
    const checks = phoneOrbitConnectionChecks({
      status: "error",
      error: gatewayError(
        "gateway.unreachable",
        "The Orbit Gateway did not answer: Network request failed",
      ),
    });
    expect(states(checks)).toEqual([
      ["gateway", "fail"],
      ["certificate", "not_checked"],
      ["device", "not_checked"],
    ]);
    expect(checks[0]!.message).toContain("WireGuard");
    expect(checks[0]!.message).toContain("root CA");
    expect(checks[1]!.message).toContain("untrusted certificate looks the same as no answer");
  });

  it("keeps the shared result when the Gateway answered", () => {
    const checks = phoneOrbitConnectionChecks({
      status: "error",
      error: gatewayError("peer.identity_unknown"),
    });
    expect(states(checks)).toEqual([
      ["gateway", "pass"],
      ["certificate", "pass"],
      ["device", "fail"],
    ]);
  });

  it("keeps a certificate failure the transport names", () => {
    const checks = phoneOrbitConnectionChecks({
      status: "error",
      error: gatewayError("gateway.unreachable", "net::ERR_CERT_AUTHORITY_INVALID"),
    });
    expect(states(checks)).toEqual([
      ["gateway", "pass"],
      ["certificate", "fail"],
      ["device", "not_checked"],
    ]);
  });
});
