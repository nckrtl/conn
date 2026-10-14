import { useAtomValue } from "@effect/atom-react";
import type { ScopedThreadRef, PreviewTabId } from "@t3tools/contracts";
import { useState, useSyncExternalStore } from "react";
import { toastManager } from "~/components/ui/toast";
import { desktopTabSharing } from "~/rpc/desktopTabRelay";
import { previewEnvironment } from "~/state/preview";
import { Button } from "~/components/ui/button";
import { Badge } from "~/components/ui/badge";

export function DesktopTabControls({
  threadRef,
  tabId,
  runtimeTabId,
  serverEpoch,
  environmentLabel,
}: {
  threadRef: ScopedThreadRef;
  tabId: PreviewTabId;
  runtimeTabId: string;
  serverEpoch: string | null;
  environmentLabel: string;
}) {
  const report = useSyncExternalStore(
    desktopTabSharing.subscribe,
    () => desktopTabSharing.get(runtimeTabId),
    () => null,
  );
  const permission = useAtomValue(
    previewEnvironment.desktopRegister.permissionAtom(threadRef.environmentId),
  );
  const [busy, setBusy] = useState(false);
  const share = async () => {
    if (!serverEpoch || busy) return;
    setBusy(true);
    try {
      await desktopTabSharing.share(
        { ...threadRef, tabId, serverEpoch, deviceName: "this desktop" },
        runtimeTabId,
      );
    } catch {
      toastManager.add({ type: "error", title: "Could not share this tab. Try again." });
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="flex items-center gap-1">
      {report?.shared ? (
        <>
          <Badge variant="secondary">Agent in control</Badge>
          <Button
            variant="outline"
            size="sm"
            onClick={() => void desktopTabSharing.stop(runtimeTabId)}
          >
            Take control
          </Button>
          <Button
            variant="ghost"
            size="sm"
            onClick={() => void desktopTabSharing.stop(runtimeTabId)}
          >
            Stop sharing
          </Button>
        </>
      ) : (
        <Button
          variant="outline"
          size="sm"
          disabled={busy || !serverEpoch || !permission}
          onClick={() => void share()}
          title={`${environmentLabel} · Thread ${threadRef.threadId}`}
        >
          Let this thread use this tab · {environmentLabel} · {threadRef.threadId}
        </Button>
      )}
    </div>
  );
}
