import type {
  VaultwardenAccount,
  VaultwardenCollection,
  VaultwardenConnection,
} from "@t3tools/contracts";
import { useEffect, useState } from "react";
import { Button } from "../ui/button";
import { Field, FieldDescription, FieldGroup, FieldLabel } from "../ui/field";
import { Input } from "../ui/input";
import { Spinner } from "../ui/spinner";
import {
  Select,
  SelectGroup,
  SelectItem,
  SelectPopup,
  SelectTrigger,
  SelectValue,
} from "../ui/select";
import { SettingsRow, SettingsSection } from "./settingsLayout";

const EMPTY: VaultwardenAccount = {
  server: "https://vault.orbit",
  clientId: "",
  clientSecret: "",
  masterPassword: "",
};

/** This machine's dedicated account. Form secrets never enter environment state or server RPC. */
export function VaultwardenSettings() {
  const setup = window.desktopBridge?.vaultwardenSetup;
  const [connection, setConnection] = useState<VaultwardenConnection | null>(null);
  const [account, setAccount] = useState<VaultwardenAccount>(EMPTY);
  const [collections, setCollections] = useState<readonly VaultwardenCollection[]>([]);
  const [selected, setSelected] = useState("");
  const [editing, setEditing] = useState(false);
  const [pendingAction, setPendingAction] = useState<"check" | "save" | "disconnect" | null>(null);
  const busy = pendingAction !== null;
  const [message, setMessage] = useState<string | null>(null);
  const [checked, setChecked] = useState(false);

  useEffect(() => {
    if (!setup) return;
    let current = true;
    void setup({ action: "status" })
      .then((result) => {
        if (current) {
          setConnection(result.connection);
          setMessage(result.error);
        }
      })
      .catch(() => {
        if (current) setMessage("Could not read the local Vaultwarden connection.");
      });
    return () => {
      current = false;
    };
  }, [setup]);

  if (!setup) return null;
  const change = (key: keyof VaultwardenAccount, value: string) => {
    setAccount((previous) => ({ ...previous, [key]: value }));
    setChecked(false);
    setCollections([]);
    setSelected("");
    setMessage(null);
  };
  const selectedCollection = collections.find((entry) => entry.id === selected);
  const close = () => {
    setAccount(EMPTY);
    setCollections([]);
    setSelected("");
    setChecked(false);
    setEditing(false);
  };
  const submit = async (save: boolean) => {
    const collection = collections.find((entry) => entry.id === selected);
    if (busy || (save && !collection)) return;
    setPendingAction(save ? "save" : "check");
    setMessage(null);
    try {
      const result = await setup(
        save && collection
          ? {
              action: "save",
              account,
              collectionId: collection.id,
              organizationId: collection.organizationId,
            }
          : { action: "check", account },
      );
      if (result.error) {
        setMessage(result.error);
        return;
      }
      if (save) {
        setConnection(result.connection);
        close();
        setMessage(
          "Connection saved on this Mac. Browser and agent credential routing is not enabled yet.",
        );
      } else {
        setCollections(result.collections);
        setChecked(true);
        setSelected(result.collections.length === 1 ? result.collections[0]!.id : "");
        if (result.collections.length === 0)
          setMessage(
            "No writable collections found. Create the organization and collection, or confirm this account's membership, then check again.",
          );
      }
    } catch {
      setMessage("Vaultwarden setup did not finish. Nothing was saved.");
    } finally {
      setPendingAction(null);
    }
  };
  const disconnect = async () => {
    setPendingAction("disconnect");
    try {
      const result = await setup({ action: "disconnect" });
      if (result.error) {
        setMessage(result.error);
        return;
      }
      setConnection(null);
      close();
      setMessage("Local connection removed. Your Vaultwarden account and items were kept.");
    } catch {
      setMessage("Could not remove the local connection.");
    } finally {
      setPendingAction(null);
    }
  };

  return (
    <SettingsSection title="Vaultwarden · this Mac">
      <SettingsRow
        title={
          connection
            ? `${connection.collection.organizationName} / ${connection.collection.name}`
            : "Dedicated Conn account"
        }
        description={
          connection
            ? `${connection.email} · ${connection.server}`
            : "Connect an account with access to the collection Conn will use."
        }
        control={
          <span className="flex gap-2">
            <Button
              variant="outline"
              size="xs"
              disabled={busy}
              onClick={() => {
                setEditing(true);
                setMessage(null);
              }}
            >
              {connection ? "Replace connection" : "Connect"}
            </Button>
            {connection && (
              <Button variant="outline" size="xs" disabled={busy} onClick={() => void disconnect()}>
                Disconnect
              </Button>
            )}
          </span>
        }
      />
      {editing && (
        <form
          className="max-w-xl p-4"
          onSubmit={(event) => {
            event.preventDefault();
            void submit(checked && !!selected);
          }}
        >
          <FieldGroup>
            <Field>
              <FieldLabel htmlFor="vaultwarden-server">Server</FieldLabel>
              <Input
                id="vaultwarden-server"
                type="url"
                value={account.server}
                disabled={busy}
                onChange={(event) => change("server", event.target.value)}
                required
              />
            </Field>
            <Field>
              <FieldLabel htmlFor="vaultwarden-client-id">Personal API client ID</FieldLabel>
              <Input
                id="vaultwarden-client-id"
                value={account.clientId}
                placeholder="user.…"
                autoComplete="off"
                disabled={busy}
                onChange={(event) => change("clientId", event.target.value)}
                required
              />
              <FieldDescription>
                In the dedicated account's web vault: Settings → Security → Keys → API key.
              </FieldDescription>
            </Field>
            <Field>
              <FieldLabel htmlFor="vaultwarden-client-secret">
                Personal API client secret
              </FieldLabel>
              <Input
                id="vaultwarden-client-secret"
                type="password"
                value={account.clientSecret}
                autoComplete="off"
                disabled={busy}
                onChange={(event) => change("clientSecret", event.target.value)}
                required
              />
            </Field>
            <Field>
              <FieldLabel htmlFor="vaultwarden-master-password">Account master password</FieldLabel>
              <Input
                id="vaultwarden-master-password"
                type="password"
                value={account.masterPassword}
                autoComplete="off"
                disabled={busy}
                onChange={(event) => change("masterPassword", event.target.value)}
                required
              />
              <FieldDescription>
                Stored with the API key in macOS Keychain. Conn needs it to encrypt and decrypt this
                account's items.
              </FieldDescription>
            </Field>
            {collections.length > 0 && (
              <Field>
                <FieldLabel htmlFor="vaultwarden-collection">Collection</FieldLabel>
                <Select
                  value={selected}
                  onValueChange={(value) => setSelected(value ?? "")}
                  disabled={busy}
                >
                  <SelectTrigger id="vaultwarden-collection">
                    <SelectValue placeholder="Choose a collection">
                      {selectedCollection
                        ? `${selectedCollection.organizationName} / ${selectedCollection.name}`
                        : undefined}
                    </SelectValue>
                  </SelectTrigger>
                  <SelectPopup>
                    <SelectGroup>
                      {collections.map((entry) => (
                        <SelectItem key={entry.id} value={entry.id}>
                          {entry.organizationName} / {entry.name}
                        </SelectItem>
                      ))}
                    </SelectGroup>
                  </SelectPopup>
                </Select>
              </Field>
            )}
            <div className="flex gap-2">
              <Button
                type="submit"
                disabled={busy || Object.values(account).some((value) => !value)}
                aria-busy={pendingAction === "check" || pendingAction === "save"}
              >
                {(pendingAction === "check" || pendingAction === "save") && (
                  <Spinner data-icon="inline-start" aria-hidden="true" />
                )}
                {pendingAction === "check"
                  ? "Checking…"
                  : pendingAction === "save"
                    ? "Saving…"
                    : checked && selected
                      ? "Save connection"
                      : "Check account"}
              </Button>
              <Button type="button" variant="outline" disabled={busy} onClick={close}>
                Cancel
              </Button>
            </div>
          </FieldGroup>
        </form>
      )}
      {message && (
        <p role="status" className="px-4 pb-4 text-sm text-muted-foreground">
          {message}
        </p>
      )}
    </SettingsSection>
  );
}
