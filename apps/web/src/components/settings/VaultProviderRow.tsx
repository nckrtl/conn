import { useEffect, useState } from "react";
import type { VaultLoginsResponse } from "@t3tools/contracts";
import { Button } from "../ui/button";
import { Spinner } from "../ui/spinner";
import { SettingsRow } from "./settingsLayout";
import { useStableCallback } from "~/hooks/useStableCallback";

export function VaultProviderRow() {
  const lookup = window.desktopBridge?.vaultLogins;
  const [state, setState] = useState<VaultLoginsResponse | null>(null);
  const [busy, setBusy] = useState(!!lookup);
  const check = useStableCallback(async () => {
    if (!lookup) return;
    await lookup({ action: "status" })
      .then(
        (result) => setState(result),
        () => setState({ status: "error", items: [], error: "Vault could not answer." }),
      )
      .finally(() => setBusy(false));
  });
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- reads the Vault status from the desktop bridge on mount
  useEffect(() => {
    void check();
  }, [check]);
  const description = !lookup
    ? "Available in the Conn desktop app on Mac."
    : busy
      ? "Checking Vault…"
      : state?.status === "ok"
        ? "Personal logins appear in the browser’s saved-login menu."
        : state?.status === "locked"
          ? "Vault is locked. Unlock it from the browser’s saved-login menu."
          : (state?.error ?? "Check the Vault app on this Mac.");
  return (
    <SettingsRow
      title="Vault · this Mac"
      description={description}
      control={
        <Button
          size="xs"
          variant="outline"
          disabled={!lookup || busy}
          aria-busy={busy}
          onClick={() => {
            setBusy(true);
            void check();
          }}
        >
          {busy && <Spinner data-icon="inline-start" aria-hidden="true" />}
          Check connection
        </Button>
      }
    />
  );
}
