import { DEFAULT_ORBIT_GATEWAY_URL } from "@t3tools/client-runtime/orbit-gateway";
import { describe, expect, it, vi } from "vite-plus/test";

import { createMobileGatewayTransport } from "./orbitGatewayClient";

const hangingFetch = ((_input: unknown, init?: RequestInit) =>
  new Promise((_resolve, reject) => {
    init?.signal?.addEventListener("abort", () =>
      reject(Object.assign(new Error("aborted"), { name: "AbortError" })),
    );
  })) as typeof fetch;

describe("createMobileGatewayTransport", () => {
  it("ends a call the Gateway does not answer at the default limit", async () => {
    vi.useFakeTimers();
    try {
      const call = createMobileGatewayTransport(
        hangingFetch,
        15_000,
      )({
        method: "GET",
        path: "/environments",
      });
      const outcome = expect(call).rejects.toThrow("The Orbit Gateway did not answer in time.");
      await vi.advanceTimersByTimeAsync(15_000);
      await outcome;
    } finally {
      vi.useRealTimers();
    }
  });

  it("uses a call's own limit", async () => {
    vi.useFakeTimers();
    try {
      let settled = false;
      const call = createMobileGatewayTransport(
        hangingFetch,
        15_000,
      )({
        method: "POST",
        path: "/environments/x/pairings",
        timeoutMs: 60_000,
      }).catch(() => {
        settled = true;
      });
      await vi.advanceTimersByTimeAsync(15_000);
      expect(settled).toBe(false);
      await vi.advanceTimersByTimeAsync(45_000);
      await call;
      expect(settled).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it("returns the status and body of an answer", async () => {
    const fetchImpl = vi.fn(async () => new Response('{"data":[]}', { status: 200 }));
    const response = await createMobileGatewayTransport(fetchImpl as unknown as typeof fetch)({
      method: "GET",
      path: "/me",
    });
    expect(response).toEqual({ status: 200, body: '{"data":[]}' });
    expect(fetchImpl).toHaveBeenCalledWith(
      `${DEFAULT_ORBIT_GATEWAY_URL}/api/v1/conn/me`,
      expect.objectContaining({ method: "GET", signal: expect.any(AbortSignal) }),
    );
  });
});
