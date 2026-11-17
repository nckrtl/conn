import {
  ORBIT_LAUNCH_ACTION_LABELS,
  ORBIT_LAUNCH_PHASE_LABELS,
  ORBIT_LAUNCH_STAGES,
  orbitLaunchActionLabel,
  orbitLaunchShowsInThreadList,
  type LegacyOrbitLaunch,
  type OrbitLaunch,
  type OrbitLaunchAction,
  type OrbitLaunchSubmission,
} from "@t3tools/client-runtime/orbit-gateway";
import * as Clipboard from "expo-clipboard";
import { useEffect, useState } from "react";
import { View } from "react-native";

import { AppText as Text } from "../../components/ui/AppText";
import { Button } from "../../components/ui/Button";
import { ErrorBanner } from "../../components/ui/ErrorBanner";
import { useOrbitGateway } from "./orbitGatewayStore";
import {
  mobileOrbitLaunches,
  mobileOrbitSubmissions,
  openMobileOrbitThread,
  readLegacyMobileLaunches,
  resolveLegacyMobileLaunch,
  updateLegacyMobilePreview,
  useMobileOrbitLaunches,
} from "./orbitThreadStartRuntime";

const actionIds = Object.keys(ORBIT_LAUNCH_ACTION_LABELS) as OrbitLaunchAction[];
const stageIds = Object.keys(ORBIT_LAUNCH_STAGES) as Array<keyof OrbitLaunch["stages"]>;
const stageStatus = {
  pending: "Waiting",
  running: "In progress",
  succeeded: "Done",
  failed: "Failed",
  cancelled: "Cancelled",
  skipped: "Skipped",
} as const;

export function OrbitThreadStartRows({
  hasThreadRow,
}: {
  hasThreadRow: (environmentId: string, threadId: string) => boolean;
}) {
  const gateway = useOrbitGateway();
  const snapshot = useMobileOrbitLaunches();
  const nodeId = gateway.node?.id ?? null;
  const profileId = gateway.node?.profile?.id ?? null;
  const [legacy, setLegacy] = useState<readonly LegacyOrbitLaunch[]>([]);
  const [pending, setPending] = useState<readonly OrbitLaunchSubmission[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- old records are read-only until the user resolves one
  useEffect(() => {
    let current = true;
    void readLegacyMobileLaunches().then(
      (rows) => {
        if (current) setLegacy(rows);
      },
      () => {
        if (current)
          setError("Conn could not read the previous Orbit starts. The saved file is unchanged.");
      },
    );
    return () => {
      current = false;
    };
  }, []);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- reads this profile's unconfirmed submissions from disk
  useEffect(() => {
    if (profileId === null || nodeId === null) return;
    let current = true;
    const read = () => {
      void mobileOrbitSubmissions.pending({ profileId, nodeId }).then(
        (rows) => {
          if (current) setPending(rows);
        },
        () => {
          if (current) setError("Conn could not read its Orbit submission journal.");
        },
      );
    };
    const stop = mobileOrbitSubmissions.subscribe(read);
    read();
    return () => {
      current = false;
      stop();
    };
  }, [profileId, nodeId]);

  const run = async (action: () => Promise<unknown>) => {
    setBusy(true);
    setError(null);
    try {
      await action();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Orbit did not confirm the action.");
    }
    setBusy(false);
  };
  const rows = snapshot.launches.filter((launch) =>
    orbitLaunchShowsInThreadList(
      launch,
      launch.thread !== null && hasThreadRow(launch.thread.environment_id, launch.thread.thread_id),
    ),
  );
  const submissions = pending.filter(
    (item) => item.profileId === profileId && item.nodeId === nodeId,
  );
  if (
    gateway.provider !== "orbit" ||
    (rows.length === 0 &&
      legacy.length === 0 &&
      submissions.length === 0 &&
      !error &&
      !snapshot.error)
  )
    return null;
  return (
    <View
      accessibilityLabel="Orbit thread starts"
      className="mx-2 mb-2 overflow-hidden rounded-[20px] bg-grouped-card"
    >
      {rows.map((launch) => (
        <View key={launch.id} className="gap-2 border-b border-border-subtle px-4 py-3">
          <Text className="text-base text-foreground">
            {launch.instance_id === null
              ? `Orbit project #${launch.project_id}`
              : `Instance #${launch.instance_id}`}
            {" · "}
            {ORBIT_LAUNCH_PHASE_LABELS[launch.phase]}
          </Text>
          {stageIds.map((id) => {
            const stage = launch.stages[id];
            if (id === "cleanup" && stage.status === "pending" && launch.phase !== "cancelling")
              return null;
            const time = stage.finished_at ?? stage.started_at;
            return (
              <View key={id} className="gap-1">
                <Text className="text-sm text-foreground-muted">
                  {ORBIT_LAUNCH_STAGES[id]} · {stageStatus[stage.status]}
                  {time ? ` · ${new Date(time).toLocaleTimeString()}` : ""}
                </Text>
                {stage.error ? (
                  <Text className="text-sm text-foreground">
                    {stage.error.detail ?? stage.error.code}
                  </Text>
                ) : null}
              </View>
            );
          })}
          {launch.thread ? (
            <Text className="text-sm text-foreground-muted">
              Model: {launch.thread.model_selection.model}
            </Text>
          ) : null}
          {launch.thread ? (
            <Button
              label="Open thread"
              disabled={busy}
              onPress={() => {
                const thread = launch.thread;
                if (thread !== null) void run(() => openMobileOrbitThread(thread));
              }}
            />
          ) : null}
          {actionIds.map((id) => {
            const action = launch.actions[id];
            if (action.available)
              return (
                <Button
                  key={id}
                  label={orbitLaunchActionLabel(id, launch.phase)}
                  disabled={busy || snapshot.error !== null}
                  onPress={() => void run(() => mobileOrbitLaunches.act(launch.id, id))}
                />
              );
            return action.requires ? (
              <Text key={id} className="text-sm text-foreground-muted">
                {action.requires === "project_process_definition"
                  ? "Update the project’s process definition before retrying."
                  : (action.reason ?? action.requires)}
              </Text>
            ) : null;
          })}
        </View>
      ))}
      {legacy.map((row) => (
        <View key={row.id} className="gap-2 border-b border-border-subtle px-4 py-3">
          <Text className="text-base text-foreground">Previous Orbit start · {row.project}</Text>
          {row.completion ? (
            <Text className="text-sm text-foreground-muted">
              Previous application preview · {row.completion.status}
              {row.completion.error ? ` · ${row.completion.error}` : ""}
            </Text>
          ) : (
            <Text className="text-sm text-foreground-muted">
              Check the previous thread before starting again. This message may have been sent.
            </Text>
          )}
          {row.environmentId && row.threadId ? (
            <Button
              label="Open previous thread"
              disabled={busy}
              onPress={() => {
                const environment_id = row.environmentId;
                const thread_id = row.threadId;
                if (environment_id !== null && thread_id !== null)
                  void run(() => openMobileOrbitThread({ environment_id, thread_id }));
              }}
            />
          ) : null}
          {row.completion ? (
            <>
              <Button
                label="Refresh preview"
                disabled={busy}
                onPress={() =>
                  void run(async () => {
                    await updateLegacyMobilePreview(row, "refresh");
                    setLegacy(await readLegacyMobileLaunches());
                  })
                }
              />
              {row.completion.retryable ? (
                <Button
                  label="Retry application"
                  disabled={busy}
                  onPress={() =>
                    void run(async () => {
                      await updateLegacyMobilePreview(row, "retry");
                      setLegacy(await readLegacyMobileLaunches());
                    })
                  }
                />
              ) : null}
            </>
          ) : null}
          {row.prompt !== null ? (
            <Button
              label="Copy saved message"
              disabled={busy}
              onPress={() => {
                const prompt = row.prompt;
                if (prompt !== null) void run(() => Clipboard.setStringAsync(prompt));
              }}
            />
          ) : null}
          <Button
            label="Dismiss saved copy"
            disabled={busy}
            onPress={() =>
              void run(async () => {
                await resolveLegacyMobileLaunch(row.id);
                setLegacy(await readLegacyMobileLaunches());
              })
            }
          />
        </View>
      ))}
      {submissions.map((row) => {
        const accepted = snapshot.launches.find((launch) => launch.launch_id === row.admission.id);
        return (
          <View key={row.admission.id} className="gap-2 border-b border-border-subtle px-4 py-3">
            <Text className="text-base text-foreground">
              {accepted ? "Orbit accepted this submission" : "Orbit submission unconfirmed"}
            </Text>
            <Text numberOfLines={1} className="text-sm text-foreground-muted">
              {row.admission.request.prompt.split("\n")[0]}
            </Text>
            <Button
              label={accepted ? "Acknowledge launch" : "Retry same submission"}
              disabled={busy || snapshot.error !== null}
              onPress={() =>
                void run(async () => {
                  if (accepted) await mobileOrbitSubmissions.acknowledge(accepted.launch_id);
                  else await mobileOrbitSubmissions.replay(row);
                })
              }
            />
          </View>
        );
      })}
      {snapshot.error ? (
        <ErrorBanner message="Could not refresh Orbit launches. Showing the last update." />
      ) : null}
      {error ? <ErrorBanner message={error} /> : null}
    </View>
  );
}
