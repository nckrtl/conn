import { describe, expect, it, vi } from "vite-plus/test";
import { page } from "vite-plus/test/browser";

import "~/index.css";
import { render, stubGlobal } from "../../../test/render";
import { setEnvironmentProvider } from "~/orbit/environmentProvider";
import { ConnectionsSettings } from "./ConnectionsSettings";

describe("Settings > Environments in Orbit mode", () => {
  it("keeps only Environments from; the Orbit sections live in the Orbit panel", async () => {
    using _bridge = stubGlobal("desktopBridge", {
      orbitGatewaySend: vi.fn(),
      getLocalEnvironmentEnabled: vi.fn(async () => true),
      getLocalEnvironmentBootstraps: vi.fn(() => []),
    });
    setEnvironmentProvider("orbit");
    using _reset = { [Symbol.dispose]: () => setEnvironmentProvider("default") };
    await using _screen = await render(<ConnectionsSettings view="environments" />, {
      router: "/settings/connections",
    });
    await expect
      .element(page.getByRole("combobox", { name: "Environments from" }))
      .toHaveTextContent("Orbit");
    for (const heading of ["Orbit Gateway", "Orbit profile", "Profile sync", "Orbit servers"]) {
      await expect.element(page.getByRole("heading", { name: heading })).not.toBeInTheDocument();
    }
  });
});
