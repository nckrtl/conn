import type { EnvironmentId } from "@t3tools/contracts";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import { useAtomValue } from "@effect/atom-react";

import { requestConfirmDialog } from "~/confirmDialog";
import { serverEnvironment } from "~/state/server";
import { useAtomCommand } from "~/state/use-atom-command";
import { MenuItem } from "./ui/menu";
import { toastManager } from "./ui/toast";

/**
 * Restarts a supervised server after confirmation. The command resolves once
 * this client is connected again, so the toast reports the real outcome.
 */
export function ServerRestartMenuItem({
  environmentId,
  serverLabel,
}: {
  readonly environmentId: EnvironmentId;
  readonly serverLabel: string;
}) {
  const restarting = useAtomValue(serverEnvironment.restartingAtom(environmentId));
  const restartServer = useAtomCommand(serverEnvironment.restartServer, { reportFailure: false });

  const handleRestart = async () => {
    const confirmed =
      (await requestConfirmDialog(
        `Restart the ${serverLabel}? Running agent turns stop, and every client disconnects until it is back.`,
        { variant: "destructive" },
      )) ?? true;
    if (!confirmed) return;
    const result = await restartServer({ environmentId });
    if (result._tag === "Failure") {
      if (isAtomCommandInterrupted(result)) return;
      const error = squashAtomCommandFailure(result);
      toastManager.add({
        type: "error",
        title: `Could not restart the ${serverLabel}`,
        description: error instanceof Error ? error.message : "The restart failed.",
      });
      return;
    }
    toastManager.add({
      type: "success",
      title: `${serverLabel} restarted`,
      description: "Reconnected.",
    });
  };

  return (
    <MenuItem disabled={restarting} onClick={() => void handleRestart()}>
      {restarting ? "Restarting…" : "Restart server"}
    </MenuItem>
  );
}
