import {
  orbitLegacyPreviewStatus,
  resolveOrbitLaunchError,
  ORBIT_LAUNCH_ACTION_LABELS,
  ORBIT_LAUNCH_PHASE_LABELS,
  ORBIT_LAUNCH_STAGES,
  ORBIT_LAUNCH_STAGE_STATUS,
  orbitLaunchActionLabel,
  type LegacyOrbitLaunch,
  type OrbitLaunch,
  type OrbitLaunchAction,
  type OrbitLaunchSubmission,
} from "@t3tools/client-runtime/orbit-gateway";
import * as Clipboard from "expo-clipboard";
import { T, msg, useGT, useMessages } from "gt-react-native";
import { useEffect, useState } from "react";
import { View } from "react-native";

import { AppText as Text } from "../../components/ui/AppText";
import { Button } from "../../components/ui/Button";
import { ErrorBanner } from "../../components/ui/ErrorBanner";
import { m } from "../../i18n/messages";
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
export function OrbitThreadStartRows() {
  const gt = useGT();
  const messages = useMessages();
  const gateway = useOrbitGateway();
  const { snapshot, rows } = useMobileOrbitLaunches();
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
          setError(
            m(msg("Conn could not read the previous Orbit starts. The saved file is unchanged.")),
          );
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
          if (current) setError(m(msg("Conn could not read its Orbit submission journal.")));
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

  const run = async (action: () => Promise<unknown>, fallback: string) => {
    setBusy(true);
    setError(null);
    try {
      await action();
    } catch (cause) {
      setError(resolveOrbitLaunchError(cause, fallback, m));
    }
    setBusy(false);
  };
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
      accessibilityLabel={gt("Orbit thread starts")}
      className="mx-2 mb-2 overflow-hidden rounded-[20px] bg-grouped-card"
    >
      {rows.map((launch) => (
        <View key={launch.id} className="gap-2 border-b border-border-subtle px-4 py-3">
          <Text className="text-base text-foreground">
            {launch.instance_id === null
              ? gt("Orbit project #{id}", { id: launch.project_id })
              : gt("Instance #{id}", { id: launch.instance_id })}
            {" · "}
            {messages(ORBIT_LAUNCH_PHASE_LABELS[launch.phase])}
          </Text>
          {stageIds.map((id) => {
            const stage = launch.stages[id];
            if (id === "cleanup" && stage.status === "pending" && launch.phase !== "cancelling")
              return null;
            const time = stage.finished_at ?? stage.started_at;
            return (
              <View key={id} className="gap-1">
                <Text className="text-sm text-foreground-muted">
                  {messages(ORBIT_LAUNCH_STAGES[id])} ·{" "}
                  {messages(ORBIT_LAUNCH_STAGE_STATUS[stage.status])}
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
              {gt("Model: {model}", { model: launch.thread.model_selection.model })}
            </Text>
          ) : null}
          {launch.thread ? (
            <Button
              label={gt("Open thread")}
              disabled={busy}
              onPress={() => {
                const thread = launch.thread;
                if (thread !== null)
                  void run(() => openMobileOrbitThread(thread), msg("Could not open the thread."));
              }}
            />
          ) : null}
          {actionIds.map((id) => {
            const action = launch.actions[id];
            if (action.available)
              return (
                <Button
                  key={id}
                  label={orbitLaunchActionLabel(id, launch.phase, messages)}
                  disabled={busy || snapshot.error !== null}
                  onPress={() =>
                    void run(
                      () => mobileOrbitLaunches.act(launch.id, id),
                      msg("Orbit did not confirm the action."),
                    )
                  }
                />
              );
            return action.requires ? (
              <Text key={id} className="text-sm text-foreground-muted">
                {action.requires === "project_process_definition"
                  ? gt("Update the project’s process definition before retrying.")
                  : (action.reason ?? action.requires)}
              </Text>
            ) : null;
          })}
        </View>
      ))}
      {legacy.map((row) => (
        <View key={row.id} className="gap-2 border-b border-border-subtle px-4 py-3">
          <Text className="text-base text-foreground">
            {gt("Previous Orbit start · {project}", { project: row.project })}
          </Text>
          {row.completion ? (
            <Text className="text-sm text-foreground-muted">
              {gt("Previous application preview · {status}", {
                status:
                  row.completion.operationId === null
                    ? gt("Retry unconfirmed")
                    : orbitLegacyPreviewStatus(row.completion.status, messages),
              })}
              {row.completion.error ? ` · ${row.completion.error}` : ""}
            </Text>
          ) : (
            <Text className="text-sm text-foreground-muted">
              <T>
                Check the previous thread before starting again. This message may have been sent.
              </T>
            </Text>
          )}
          {row.environmentId && row.threadId ? (
            <Button
              label={gt("Open previous thread")}
              disabled={busy}
              onPress={() => {
                const environment_id = row.environmentId;
                const thread_id = row.threadId;
                if (environment_id !== null && thread_id !== null)
                  void run(
                    () => openMobileOrbitThread({ environment_id, thread_id }),
                    msg("Could not open the thread."),
                  );
              }}
            />
          ) : null}
          {row.completion ? (
            <>
              {row.completion.operationId !== null ? (
                <Button
                  label={gt("Refresh preview")}
                  disabled={busy}
                  onPress={() =>
                    void run(async () => {
                      await updateLegacyMobilePreview(row, "refresh");
                      setLegacy(await readLegacyMobileLaunches());
                    }, msg("Orbit did not confirm the preview."))
                  }
                />
              ) : null}
              {row.completion.retryable ? (
                <Button
                  label={
                    row.completion.operationId === null
                      ? gt("Resume preview retry")
                      : gt("Retry application")
                  }
                  disabled={busy}
                  onPress={() =>
                    void run(async () => {
                      await updateLegacyMobilePreview(row, "retry");
                      setLegacy(await readLegacyMobileLaunches());
                    }, msg("Orbit did not confirm the preview."))
                  }
                />
              ) : null}
            </>
          ) : null}
          {row.prompt !== null ? (
            <Button
              label={gt("Copy saved message")}
              disabled={busy}
              onPress={() => {
                const prompt = row.prompt;
                if (prompt !== null)
                  void run(
                    () => Clipboard.setStringAsync(prompt),
                    msg("Could not copy the message."),
                  );
              }}
            />
          ) : null}
          <Button
            label={gt("Dismiss saved copy")}
            disabled={busy}
            onPress={() =>
              void run(async () => {
                await resolveLegacyMobileLaunch(row.id);
                setLegacy(await readLegacyMobileLaunches());
              }, msg("Could not dismiss the previous start."))
            }
          />
        </View>
      ))}
      {submissions.map((row) => {
        const accepted = snapshot.launches.find((launch) => launch.launch_id === row.admission.id);
        return (
          <View key={row.admission.id} className="gap-2 border-b border-border-subtle px-4 py-3">
            <Text className="text-base text-foreground">
              {accepted
                ? gt("Orbit accepted this submission")
                : row.validationRefused
                  ? gt("Orbit refused the retry")
                  : gt("Orbit submission unconfirmed")}
            </Text>
            <Text numberOfLines={1} className="text-sm text-foreground-muted">
              {row.admission.request.prompt.split("\n")[0]}
            </Text>
            <Button
              label={
                accepted
                  ? gt("Acknowledge launch")
                  : row.superseded
                    ? gt("Dismiss saved copy")
                    : gt("Retry same submission")
              }
              disabled={busy || (!row.superseded && snapshot.error !== null)}
              onPress={() =>
                void run(
                  async () => {
                    if (accepted || row.superseded)
                      await mobileOrbitSubmissions.acknowledge(row.admission.id);
                    else await mobileOrbitSubmissions.replay(row);
                  },
                  accepted || row.superseded
                    ? msg("Could not dismiss the saved submission.")
                    : msg("Orbit did not confirm the submission."),
                )
              }
            />
          </View>
        );
      })}
      {snapshot.error ? (
        <ErrorBanner message={gt("Could not refresh Orbit launches. Showing the last update.")} />
      ) : null}
      {error ? <ErrorBanner message={error} /> : null}
    </View>
  );
}
