import type {
  LegacyOrbitLaunch,
  OrbitLaunchSubmission,
} from "@t3tools/client-runtime/orbit-gateway";
import { Link } from "@tanstack/react-router";
import { T, msg, useGT } from "gt-react";
import { useEffect, useState } from "react";

import { Button } from "../components/ui/button";
import { composerDraftHasUserContent, DraftId, useComposerDraftStore } from "../composerDraftStore";
import { m } from "../i18n/messages";
import { orbitDraftMatchesLaunch } from "./orbitDraft";
import {
  orbitLaunchSubmissions,
  readLegacyWebLaunches,
  resolveLegacyWebLaunch,
  updateLegacyWebPreview,
  useOrbitLaunchScope,
  useOrbitLaunches,
} from "./orbitLaunches";

export function OrbitLaunchRecovery() {
  const gt = useGT();
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
              m(
                msg(
                  "Conn could not read the previous Orbit starts. Their saved data is still on this device.",
                ),
              ),
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
          if (current) setError(m(msg("Conn could not read its Orbit submission journal.")));
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
    const latest = await orbitLaunchSubmissions.draft(row.draftId, row);
    const store = useComposerDraftStore.getState();
    const draftId = DraftId.make(row.draftId);
    const draft = store.getComposerDraft(draftId);
    const request = row.admission.request;
    const currentModel = draft?.activeProvider
      ? draft.modelSelectionByProvider[draft.activeProvider]
      : undefined;
    if (
      latest?.admission.id === row.admission.id &&
      draft !== null &&
      !composerDraftHasUserContent({ ...draft, prompt: "" }) &&
      (draft.runtimeMode === null || draft.runtimeMode === request.runtime_mode) &&
      (draft.interactionMode === null || draft.interactionMode === request.interaction_mode) &&
      (!draft.modelSelectionExplicit ||
        JSON.stringify(currentModel) === JSON.stringify(request.model_selection)) &&
      orbitDraftMatchesLaunch(store.getDraftSession(draftId)?.orbitTarget, draft.prompt, request)
    ) {
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
      setError(
        cause instanceof Error ? cause.message : m(msg("Orbit did not confirm the submission.")),
      );
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
      setError(
        cause instanceof Error ? cause.message : m(msg("Orbit did not confirm the preview.")),
      );
    }
    setBusy(null);
  }

  return (
    <>
      {legacy.map((row) => (
        <details key={row.id} className="grid gap-1 px-2 py-1 text-ui">
          <summary>{gt("Previous Orbit start · {project}", { project: row.project })}</summary>
          {row.completion ? (
            <p className="text-muted-foreground">
              {gt("Previous application preview · {status}", {
                status:
                  row.completion.operationId === null
                    ? gt("Retry unconfirmed")
                    : row.completion.status,
              })}
              {row.completion.error ? ` · ${row.completion.error}` : ""}
            </p>
          ) : (
            <p className="text-muted-foreground">
              <T>
                Check the previous thread before starting again. This message may have been sent.
              </T>
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
              <T>Open previous thread</T>
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
                    <T>Refresh preview</T>
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
                      ? gt("Resume preview retry")
                      : gt("Retry application")}
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
                      .catch(() => setError(m(msg("Could not copy the message."))));
                }}
              >
                <T>Copy message</T>
              </Button>
            ) : null}
            <Button
              size="xs"
              variant="ghost-muted"
              disabled={busy !== null}
              onClick={() =>
                void resolveLegacyWebLaunch(row.id)
                  .then(() => setLegacy(readLegacyWebLaunches()))
                  .catch(() => setError(m(msg("Could not dismiss the previous start."))))
              }
            >
              <T>Dismiss saved copy</T>
            </Button>
          </div>
        </details>
      ))}
      {submissions.map((row) => {
        const accepted = snapshot.launches.find((launch) => launch.launch_id === row.admission.id);
        return (
          <div key={row.admission.id} className="grid gap-1 px-2 py-1 text-ui">
            <p>
              {accepted
                ? gt("Orbit accepted this submission")
                : row.validationRefused
                  ? gt("Orbit refused the retry")
                  : gt("Orbit submission unconfirmed")}
            </p>
            <p className="truncate text-muted-foreground">
              {row.admission.request.prompt.split("\n")[0]}
            </p>
            {accepted ? (
              <Link
                to="/orbit/$startId"
                params={{ startId: accepted.launch_id }}
                onClick={() =>
                  void acknowledge(row).catch(() =>
                    setError(m(msg("Could not clear the recovered draft."))),
                  )
                }
              >
                <T>Open recovered launch</T>
              </Link>
            ) : row.superseded ? (
              <Button
                size="xs"
                variant="ghost-muted"
                disabled={busy !== null}
                onClick={() =>
                  void orbitLaunchSubmissions
                    .acknowledge(row.admission.id)
                    .catch(() => setError(m(msg("Could not dismiss the saved submission."))))
                }
              >
                <T>Dismiss saved copy</T>
              </Button>
            ) : (
              <div>
                {row.validationRefused ? (
                  <p className="text-muted-foreground">
                    <T>
                      You can edit the draft and send a correction. The original submission stays
                      here.
                    </T>
                  </p>
                ) : null}
                <Button
                  size="xs"
                  variant="outline"
                  disabled={busy !== null || snapshot.error !== null}
                  onClick={() => void replay(row)}
                >
                  <T>Retry same submission</T>
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
