import type {
  LegacyOrbitLaunch,
  OrbitLaunchSubmission,
} from "@t3tools/client-runtime/orbit-gateway";
import { Link } from "@tanstack/react-router";
import { useEffect, useState } from "react";

import { Button } from "../components/ui/button";
import { DraftId, useComposerDraftStore } from "../composerDraftStore";
import {
  orbitLaunchSubmissions,
  readLegacyWebLaunches,
  resolveLegacyWebLaunch,
  updateLegacyWebPreview,
  useOrbitLaunchScope,
  useOrbitLaunches,
} from "./orbitLaunches";

export function OrbitLaunchRecovery() {
  const scope = useOrbitLaunchScope();
  const profileId = scope?.profileId ?? null;
  const nodeId = scope?.nodeId ?? null;
  const snapshot = useOrbitLaunches();
  const [legacy, setLegacy] = useState<readonly LegacyOrbitLaunch[]>([]);
  const [pending, setPending] = useState<readonly OrbitLaunchSubmission[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- reads this device's pre-cutover starts for manual recovery
  useEffect(() => {
    let current = true;
    void Promise.resolve()
      .then(readLegacyWebLaunches)
      .then(
        (rows) => {
          if (current) setLegacy(rows);
        },
        () => {
          if (current)
            setError(
              "Conn could not read the previous Orbit starts. Their saved data is still on this device.",
            );
        },
      );
    return () => {
      current = false;
    };
  }, []);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- reads only this profile's journal revision
  useEffect(() => {
    if (profileId === null || nodeId === null) return;
    let current = true;
    const read = () => {
      void orbitLaunchSubmissions.pending({ profileId, nodeId }).then(
        (rows) => {
          if (current) setPending(rows);
        },
        () => {
          if (current) setError("Conn could not read its Orbit submission journal.");
        },
      );
    };
    const stop = orbitLaunchSubmissions.subscribe(read);
    read();
    return () => {
      current = false;
      stop();
    };
  }, [profileId, nodeId]);
  const submissions = pending.filter(
    (item) => item.profileId === profileId && item.nodeId === nodeId,
  );

  async function acknowledge(row: OrbitLaunchSubmission) {
    const store = useComposerDraftStore.getState();
    const draftId = DraftId.make(row.draftId);
    if (store.getComposerDraft(draftId)?.prompt.trim() === row.admission.request.prompt) {
      store.clearDraftThread(draftId);
    }
    await orbitLaunchSubmissions.acknowledge(row.admission.id);
  }

  async function replay(item: OrbitLaunchSubmission) {
    setError(null);
    setBusy(item.admission.id);
    try {
      await orbitLaunchSubmissions.replay(item);
      setPending(await orbitLaunchSubmissions.pending(item));
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Orbit did not confirm the submission.");
    }
    setBusy(null);
  }
  async function legacyPreview(row: LegacyOrbitLaunch, action: "refresh" | "retry") {
    setBusy(row.id);
    setError(null);
    try {
      await updateLegacyWebPreview(row, action);
      setLegacy(readLegacyWebLaunches());
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Orbit did not confirm the preview.");
    }
    setBusy(null);
  }

  return (
    <>
      {legacy.map((row) => (
        <details key={row.id} className="grid gap-1 px-2 py-1 text-ui">
          <summary>Previous Orbit start · {row.project}</summary>
          {row.completion ? (
            <p className="text-muted-foreground">
              Previous application preview ·{" "}
              {row.completion.operationId === null ? "Retry unconfirmed" : row.completion.status}
              {row.completion.error ? ` · ${row.completion.error}` : ""}
            </p>
          ) : (
            <p className="text-muted-foreground">
              Check the previous thread before starting again. This message may have been sent.
            </p>
          )}
          {row.prompt !== null ? (
            <p className="max-h-32 overflow-auto whitespace-pre-wrap">{row.prompt}</p>
          ) : null}
          {row.environmentId && row.threadId ? (
            <Link
              to="/$environmentId/$threadId"
              params={{ environmentId: row.environmentId, threadId: row.threadId }}
            >
              Open previous thread
            </Link>
          ) : null}
          <div className="flex flex-wrap gap-1">
            {row.completion ? (
              <>
                {row.completion.operationId !== null ? (
                  <Button
                    size="xs"
                    variant="outline"
                    disabled={busy !== null}
                    onClick={() => void legacyPreview(row, "refresh")}
                  >
                    Refresh preview
                  </Button>
                ) : null}
                {row.completion.retryable ? (
                  <Button
                    size="xs"
                    variant="outline"
                    disabled={busy !== null}
                    onClick={() => void legacyPreview(row, "retry")}
                  >
                    {row.completion.operationId === null
                      ? "Resume preview retry"
                      : "Retry application"}
                  </Button>
                ) : null}
              </>
            ) : null}
            {row.prompt !== null ? (
              <Button
                size="xs"
                variant="outline"
                onClick={() => {
                  const prompt = row.prompt;
                  if (prompt !== null)
                    void navigator.clipboard
                      .writeText(prompt)
                      .catch(() => setError("Could not copy the message."));
                }}
              >
                Copy message
              </Button>
            ) : null}
            <Button
              size="xs"
              variant="ghost-muted"
              disabled={busy !== null}
              onClick={() =>
                void resolveLegacyWebLaunch(row.id)
                  .then(() => setLegacy(readLegacyWebLaunches()))
                  .catch(() => setError("Could not dismiss the previous start."))
              }
            >
              Dismiss saved copy
            </Button>
          </div>
        </details>
      ))}
      {submissions.map((row) => {
        const accepted = snapshot.launches.find((launch) => launch.launch_id === row.admission.id);
        return (
          <div key={row.admission.id} className="grid gap-1 px-2 py-1 text-ui">
            <p>{accepted ? "Orbit accepted this submission" : "Orbit submission unconfirmed"}</p>
            <p className="truncate text-muted-foreground">
              {row.admission.request.prompt.split("\n")[0]}
            </p>
            {accepted ? (
              <Link
                to="/orbit/$startId"
                params={{ startId: accepted.launch_id }}
                onClick={() =>
                  void acknowledge(row).catch(() =>
                    setError("Could not clear the recovered draft."),
                  )
                }
              >
                Open recovered launch
              </Link>
            ) : (
              <div>
                <Button
                  size="xs"
                  variant="outline"
                  disabled={busy !== null || snapshot.error !== null}
                  onClick={() => void replay(row)}
                >
                  Retry same submission
                </Button>
              </div>
            )}
          </div>
        );
      })}
      {error ? (
        <p role="alert" className="px-2 text-ui text-destructive-foreground">
          {error}
        </p>
      ) : null}
    </>
  );
}
