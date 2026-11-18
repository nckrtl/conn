import {
  resolveOrbitLaunchError,
  ORBIT_LAUNCH_ACTION_LABELS,
  ORBIT_LAUNCH_PHASE_LABELS,
  ORBIT_LAUNCH_STAGES,
  ORBIT_LAUNCH_STAGE_STATUS,
  orbitLaunchActionLabel,
  type OrbitLaunch,
  type OrbitLaunchAction,
} from "@t3tools/client-runtime/orbit-gateway";
import { T, msg, useGT, useMessages } from "gt-react";
import { useState } from "react";

import { m } from "../i18n/messages";

import { Button } from "../components/ui/button";
import { orbitLaunches } from "./orbitLaunches";

const stageIds = Object.keys(ORBIT_LAUNCH_STAGES) as Array<keyof OrbitLaunch["stages"]>;
const actionIds = Object.keys(ORBIT_LAUNCH_ACTION_LABELS) as OrbitLaunchAction[];

export function OrbitLaunchProgress({ launch, stale }: { launch: OrbitLaunch; stale?: boolean }) {
  const gt = useGT();
  const messages = useMessages();
  const [busy, setBusy] = useState<OrbitLaunchAction | null>(null);
  const [error, setError] = useState<string | null>(null);
  async function act(action: OrbitLaunchAction) {
    setBusy(action);
    setError(null);
    try {
      await orbitLaunches.act(launch.id, action);
    } catch (cause) {
      setError(resolveOrbitLaunchError(cause, msg("Orbit did not confirm this action."), m));
    }
    setBusy(null);
  }
  return (
    <section
      aria-label={gt("Orbit launch")}
      className="flex flex-col gap-2 text-ui"
      data-orbit-launch-phase={launch.phase}
    >
      <p className="font-medium">{messages(ORBIT_LAUNCH_PHASE_LABELS[launch.phase])}</p>
      <ul className="grid gap-1">
        {stageIds.map((id) => {
          const stage = launch.stages[id];
          if (id === "cleanup" && stage.status === "pending" && launch.phase !== "cancelling")
            return null;
          const time = stage.finished_at ?? stage.started_at;
          return (
            <li key={id} className="grid gap-0.5">
              <div className="flex items-baseline justify-between gap-2">
                <span>{messages(ORBIT_LAUNCH_STAGES[id])}</span>
                <span className="text-muted-foreground">
                  {messages(ORBIT_LAUNCH_STAGE_STATUS[stage.status])}
                  {time ? (
                    <>
                      {" "}
                      · <time dateTime={time}>{new Date(time).toLocaleTimeString()}</time>
                    </>
                  ) : null}
                </span>
              </div>
              {stage.error ? (
                <p className="text-destructive-foreground">
                  {stage.error.detail ?? stage.error.code}
                </p>
              ) : null}
            </li>
          );
        })}
      </ul>
      {launch.thread ? (
        <p className="text-muted-foreground">
          {gt("Model: {model}", { model: launch.thread.model_selection.model })}
        </p>
      ) : null}
      {stale ? (
        <p role="status" className="text-muted-foreground">
          <T>Can’t refresh Orbit right now. Showing the last update.</T>
        </p>
      ) : null}
      {error ? (
        <p role="alert" className="text-destructive-foreground">
          {error}
        </p>
      ) : null}
      <div className="flex flex-wrap gap-2">
        {actionIds
          .filter((action) => launch.actions[action].available)
          .map((action) => (
            <Button
              key={action}
              size="sm"
              variant="outline"
              disabled={busy !== null || stale}
              onClick={() => void act(action)}
            >
              {orbitLaunchActionLabel(action, launch.phase, messages)}
            </Button>
          ))}
      </div>
      {actionIds.map((id) => {
        const action = launch.actions[id];
        return !action.available && action.requires ? (
          <p key={id} className="text-muted-foreground">
            {action.requires === "project_process_definition"
              ? gt("Update the project’s process definition before retrying.")
              : (action.reason ?? action.requires)}
          </p>
        ) : null;
      })}
    </section>
  );
}
