import type { DesktopVaultDatabasesResponse } from "@t3tools/contracts";
import { useEffect, useState } from "react";

import { connectionFromVault, type DatabaseConnection } from "./databaseApi";
import { useStableCallback } from "~/hooks/useStableCallback";

export interface VaultDatabases {
  /** False outside the desktop app, or when Vault is not installed. */
  readonly available: boolean;
  readonly status: DesktopVaultDatabasesResponse["status"] | "loading";
  readonly connections: readonly DatabaseConnection[];
  readonly error: string | null;
  /** Reads the list again. `allowUnlock` lets a locked Vault ask for Touch ID. */
  readonly reload: (allowUnlock: boolean) => void;
}

const EMPTY: readonly DatabaseConnection[] = [];

/** The Database entries in the Vault Mac app. The first read never prompts. */
export function useVaultDatabases(): VaultDatabases {
  const list = window.desktopBridge?.vaultDatabases;
  const [state, setState] = useState<{
    status: VaultDatabases["status"];
    connections: readonly DatabaseConnection[];
    error: string | null;
  }>({ status: list ? "loading" : "unavailable", connections: EMPTY, error: null });

  const reload = useStableCallback((allowUnlock: boolean) => {
    if (!list) return;
    void list({ allowUnlock }).then(
      (response) =>
        setState({
          status: response.status,
          connections: response.databases.map(connectionFromVault),
          error: response.error,
        }),
      (error: unknown) =>
        setState({
          status: "error",
          connections: EMPTY,
          error: error instanceof Error ? error.message : String(error),
        }),
    );
  });

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- lists Vault database entries from the desktop bridge once on mount
  useEffect(() => reload(false), [reload]);

  return { available: state.status !== "unavailable", ...state, reload };
}
