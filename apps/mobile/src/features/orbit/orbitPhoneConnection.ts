import {
  OrbitGatewayError,
  orbitConnectionChecks,
  type OrbitConnectionCheck,
  type OrbitConnectionProbe,
} from "@t3tools/client-runtime/orbit-gateway";
import * as Schema from "effect/Schema";

// Conn: React Native's fetch rejects every transport failure (no route, timeout, refused TLS) with
// one "Network request failed", so the phone cannot tell an untrusted certificate from no answer.
const isGatewayError = Schema.is(OrbitGatewayError);

const PHONE_GATEWAY_FAILED =
  "gateway.orbit does not answer this phone. Check that the WireGuard tunnel is on. If it is, check that the Orbit root CA is installed and trusted on this phone (Settings › General › About › Certificate Trust Settings). Then Reload.";

const PHONE_CERTIFICATE_NOT_CHECKED =
  "Not checked: on this phone an untrusted certificate looks the same as no answer.";

function isPhoneTransportFailure(error: unknown): boolean {
  return !isGatewayError(error) || error.code === "gateway.unreachable";
}

export function phoneOrbitConnectionChecks(probe: OrbitConnectionProbe): OrbitConnectionCheck[] {
  const checks = orbitConnectionChecks(probe);
  if (probe.status !== "error" || !isPhoneTransportFailure(probe.error)) return checks;
  if (checks.find((check) => check.key === "gateway")?.state !== "fail") return checks;
  return checks.map((check) =>
    check.key === "gateway"
      ? { ...check, message: PHONE_GATEWAY_FAILED }
      : check.key === "certificate"
        ? { ...check, message: PHONE_CERTIFICATE_NOT_CHECKED }
        : check,
  );
}
