import type { VaultLoginsRequest, VaultLoginsResponse } from "@t3tools/contracts";
import { CredentialItemId } from "@t3tools/contracts";
import { expect, it, vi } from "vite-plus/test";

import { render, stubGlobal } from "../../test/render";
import { useVaultLogins } from "./useVaultLogins";

const reply: VaultLoginsResponse = {
  status: "ok",
  items: [
    {
      id: CredentialItemId.make("00000000-0000-4000-8000-000000000001"),
      title: "Fixture login",
      username: "test@example.invalid",
      source: "vault",
    },
  ],
  error: null,
};

function Probe(props: { readonly url: string | null }) {
  const vault = useVaultLogins(props.url);
  return (
    <output>
      {vault.busy ? "busy" : (vault.result?.items.map((item) => item.title).join(",") ?? "none")}
    </output>
  );
}

it("lists logins for each page URL, including one that appears after mount", async () => {
  const lookup = vi.fn(async (_request: VaultLoginsRequest) => reply);
  using _bridge = stubGlobal("desktopBridge", { vaultLogins: lookup });
  // The hook needs no routing. The key button mounts before field detection, so the first URL is null.
  await using screen = await render(<Probe url={null} />, { router: false });
  expect(lookup).not.toHaveBeenCalled();

  await screen.rerender(<Probe url="https://example.invalid/login" />);
  await expect.element(screen.getByText("Fixture login")).toBeInTheDocument();

  await screen.rerender(<Probe url="https://other.example.invalid/sign-in" />);
  await expect
    .poll(() => lookup.mock.calls.map(([request]) => request.action === "list" && request.url))
    .toEqual(["https://example.invalid/login", "https://other.example.invalid/sign-in"]);
});
