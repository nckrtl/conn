import type {
  OrbitGatewayClient,
  OrbitGatewayEnvironment,
} from "@t3tools/client-runtime/orbit-gateway";
import { describe, expect, it, vi } from "vite-plus/test";
import { page } from "vite-plus/test/browser";

import "~/index.css";
import { connectOrbitEnvironment } from "~/orbit/environmentProvider";
import { render } from "../../../test/render";
import { OrbitServerControl } from "./OrbitSettings";

const server = (instanceId: number | null): OrbitGatewayEnvironment => ({
  environmentId: instanceId === null ? "host" : `clone-${instanceId}`,
  label: instanceId === null ? "host" : `clone-${instanceId}`,
  url: "http://10.44.0.9:3773",
  serverVersion: null,
  registeredBy: null,
  registeredAt: "2026-11-10T10:00:00+00:00",
  status: "registered",
  instanceId,
  powerState: instanceId === null ? null : "running",
  projectId: null,
  projectName: null,
  projectSlug: null,
  instanceName: null,
  nodeName: null,
  instanceUrl: null,
});

describe("OrbitServerControl", () => {
  it("leaves a host server to the sync", async () => {
    await using _screen = await render(
      <OrbitServerControl
        gateway={null}
        environment={server(null)}
        connected={false}
        starting={false}
      />,
    );
    await expect.element(page.getByText("Pairing…")).toBeVisible();
    await expect.element(page.getByRole("button", { name: "Connect" })).not.toBeInTheDocument();
  });

  it("pairs a clone once when the user connects it, and offers Connect again after a failure", async () => {
    let fail: (error: Error) => void = () => {};
    const pair = vi.fn(
      () =>
        new Promise<never>((_, reject) => {
          fail = reject;
        }),
    );
    const client = { pair } as unknown as OrbitGatewayClient;
    await using _screen = await render(
      <OrbitServerControl
        gateway={client}
        environment={server(41)}
        connected={false}
        starting={false}
      />,
    );
    await expect.element(page.getByText("Not connected")).toBeVisible();
    await page.getByRole("button", { name: "Connect" }).click();
    await expect.element(page.getByText("Pairing…")).toBeVisible();
    await expect.element(page.getByRole("button", { name: "Connect" })).not.toBeInTheDocument();
    expect(pair).toHaveBeenCalledTimes(1);
    expect(pair).toHaveBeenCalledWith("clone-41");
    // A sync or a second Connect while the pairing runs joins it instead of pairing again.
    const joined = connectOrbitEnvironment(client, server(41));
    expect(pair).toHaveBeenCalledTimes(1);

    fail(new Error("unreachable"));
    await expect(joined).resolves.toBe(false);
    await expect.element(page.getByRole("button", { name: "Connect" })).toBeVisible();
    expect(pair).toHaveBeenCalledTimes(1);
  });
});
