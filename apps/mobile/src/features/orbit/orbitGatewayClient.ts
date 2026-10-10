import {
  createOrbitGatewayClient,
  DEFAULT_ORBIT_GATEWAY_URL,
} from "@t3tools/client-runtime/orbit-gateway";

/** The Gateway knows the phone by its WireGuard address, so the calls carry no credentials. */
export const orbitGatewayClient = createOrbitGatewayClient(async (request) => {
  const response = await fetch(`${DEFAULT_ORBIT_GATEWAY_URL}/api/v1/conn${request.path}`, {
    method: request.method,
    headers: {
      Accept: "application/json",
      ...(request.body === undefined ? {} : { "Content-Type": "application/json" }),
    },
    ...(request.body === undefined ? {} : { body: JSON.stringify(request.body) }),
  });
  return { status: response.status, body: await response.text() };
});
