import { useEffect, useRef, useState } from "react";
import type { VaultLoginsResponse } from "@t3tools/contracts";
import { useStableCallback } from "~/hooks/useStableCallback";

/** Local metadata only. A slow or locked provider never blocks the other suggestion sources. */
export function useVaultLogins(url: string | null) {
  const lookup = window.desktopBridge?.vaultLogins;
  const generation = useRef(0);
  const [state, setState] = useState<{
    url: string;
    busy: boolean;
    result: VaultLoginsResponse | null;
  } | null>(null);
  // The mount effect calls this; a stable identity keeps rerenders from re-listing.
  const load = useStableCallback(async (allowUnlock: boolean = false) => {
    if (!lookup || !url) return;
    const current = ++generation.current;
    await lookup({ action: "list", url, allowUnlock }).then(
      (result) => {
        if (current === generation.current) setState({ url, busy: false, result });
      },
      () => {
        if (current === generation.current)
          setState({
            url,
            busy: false,
            result: { status: "error", items: [], error: "Vault could not answer." },
          });
      },
    );
  });
  const refresh = (allowUnlock = false) => {
    if (!lookup || !url) return Promise.resolve();
    setState((previous) => ({
      url,
      busy: true,
      result: previous?.url === url ? previous.result : null,
    }));
    return load(allowUnlock);
  };
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- lists Vault logins for the page URL from the desktop bridge
  useEffect(() => {
    void load();
    return () => {
      generation.current++;
    };
  }, [load]);
  const current = state?.url === url ? state : null;
  return {
    supported: !!lookup,
    busy: current?.busy ?? (!!url && !!lookup),
    result: current?.result ?? null,
    refresh,
  };
}
