import { useCallback, useEffect, useRef, useState } from "react";
import type { VaultLoginsResponse } from "@t3tools/contracts";

/** Local metadata only. A slow or locked provider never blocks the other suggestion sources. */
export function useVaultLogins(url: string | null) {
  const lookup = window.desktopBridge?.vaultLogins;
  const generation = useRef(0);
  const [state, setState] = useState<{
    url: string;
    busy: boolean;
    result: VaultLoginsResponse | null;
  } | null>(null);
  const load = useCallback(
    async (allowUnlock = false) => {
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
    },
    [lookup, url],
  );
  const refresh = useCallback(
    (allowUnlock = false) => {
      if (!lookup || !url) return Promise.resolve();
      setState((previous) => ({
        url,
        busy: true,
        result: previous?.url === url ? previous.result : null,
      }));
      return load(allowUnlock);
    },
    [lookup, url, load],
  );
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
