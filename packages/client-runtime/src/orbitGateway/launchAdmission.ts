import * as Schema from "effect/Schema";
import { msg } from "gt-i18n";

import type { OrbitGatewayClient, OrbitGatewayOperation } from "./client.ts";
import { OrbitLaunchCopyError } from "./launchCopy.ts";
import { OrbitLaunchAdmissionRefused } from "./launchObserver.ts";
import type {
  OrbitLaunch,
  OrbitLaunchAdmission,
  OrbitLaunchRequest,
  OrbitLaunchScope,
} from "./launches.ts";

const isAdmissionRefused = Schema.is(OrbitLaunchAdmissionRefused);

export interface OrbitLaunchSubmission extends OrbitLaunchScope {
  readonly draftId: string;
  readonly admission: OrbitLaunchAdmission;
  readonly validationRefused?: true;
  readonly superseded?: true;
  readonly acknowledgedFingerprint?: string;
}

export interface OrbitLaunchSubmissionStorage {
  readonly lock?: <T>(work: () => Promise<T>) => Promise<T>;
  readonly fingerprintAcknowledged?: (input: string) => string;
  readonly lockDraft?: <T>(draftId: string, work: () => Promise<T>) => Promise<T>;
  readonly load: () => Promise<readonly OrbitLaunchSubmission[]>;
  readonly save: (records: readonly OrbitLaunchSubmission[]) => Promise<void>;
}

/** A journal for the admission response only. It never follows or runs the accepted operation. */
export function createOrbitLaunchSubmissions(
  storage: OrbitLaunchSubmissionStorage,
  submit: (record: OrbitLaunchSubmission, reconcile: boolean | "accepted") => Promise<OrbitLaunch>,
) {
  let tail = Promise.resolve();
  const listeners = new Set<() => void>();
  function update<T>(
    change: (records: readonly OrbitLaunchSubmission[]) => {
      readonly records: readonly OrbitLaunchSubmission[];
      readonly result: T;
    },
  ): Promise<T> {
    const work = async () => {
      const before = await storage.load();
      const { records, result } = change(before);
      if (records !== before) {
        await storage.save(records);
        for (const listener of listeners) listener();
      }
      return result;
    };
    const updated = tail.then(() => (storage.lock ? storage.lock(work) : work()));
    tail = updated.then(
      () => {},
      () => {},
    );
    return updated;
  }

  function remove(id: string, ready?: (record: OrbitLaunchSubmission) => boolean) {
    return update((records) => {
      const record = records.find(({ admission }) => admission.id === id);
      if (record === undefined || (ready !== undefined && !ready(record))) {
        return { records, result: false };
      }
      if (record.acknowledgedFingerprint !== undefined) return { records, result: true };
      const fingerprint = ready && storage.fingerprintAcknowledged;
      if (!fingerprint) return { records: records.filter((row) => row !== record), result: true };
      // Keep the original identity across renderer windows without retaining the sent prompt.
      const acknowledged = {
        ...record,
        acknowledgedFingerprint: fingerprint(acknowledgedInput(record.admission.request)),
        admission: {
          ...record.admission,
          request: { ...record.admission.request, prompt: "" },
        },
      };
      return { records: records.map((row) => (row === record ? acknowledged : row)), result: true };
    });
  }

  function latestAttempt(
    records: readonly OrbitLaunchSubmission[],
    draftId: string,
    scope: OrbitLaunchScope,
  ) {
    const attempts = records.filter(
      (row) => row.draftId === draftId && row.acknowledgedFingerprint === undefined,
    );
    if (attempts.some((row) => row.profileId !== scope.profileId || row.nodeId !== scope.nodeId)) {
      throw OrbitLaunchCopyError.fromCopy(
        msg("Connect to the original Orbit profile and device to resolve this draft."),
      );
    }
    return attempts.findLast((row) => !row.superseded);
  }

  const inFlight = new Set<string>();
  async function withDraft<T>(draftId: string, work: () => Promise<T>): Promise<T> {
    if (inFlight.has(draftId))
      throw OrbitLaunchCopyError.fromCopy(msg("Conn is already checking this Orbit submission."));
    inFlight.add(draftId);
    try {
      return await (storage.lockDraft ? storage.lockDraft(draftId, work) : work());
    } finally {
      inFlight.delete(draftId);
    }
  }

  function clearRefusal(records: readonly OrbitLaunchSubmission[], saved: OrbitLaunchSubmission) {
    if (!saved.validationRefused) return records;
    const { validationRefused: _, ...pending } = saved;
    return records.map((row) => (row === saved ? pending : row));
  }

  async function send(record: OrbitLaunchSubmission, reconcile: boolean): Promise<OrbitLaunch> {
    try {
      return await submit(record, reconcile);
    } catch (error) {
      if (isAdmissionRefused(error)) {
        if (
          error.cause.status === 422 &&
          (reconcile || record.admission.request.source === "mobile")
        ) {
          await update((records) => ({
            records: records.map((row) =>
              row.admission.id === record.admission.id
                ? ({ ...row, validationRefused: true } as const)
                : row,
            ),
            result: undefined,
          }));
        } else if (!reconcile && record.admission.request.source !== "mobile") {
          await remove(record.admission.id);
        }
      }
      throw error;
    }
  }

  return {
    submit(record: OrbitLaunchSubmission) {
      return withDraft(record.draftId, async () => {
        const { saved, reconcile } = await update<{
          saved: OrbitLaunchSubmission;
          reconcile: boolean | "accepted";
        }>((records) => {
          const fingerprint = storage.fingerprintAcknowledged?.(
            acknowledgedInput(record.admission.request),
          );
          const acknowledged =
            fingerprint === undefined
              ? undefined
              : records.find(
                  (row) =>
                    row.draftId === record.draftId && row.acknowledgedFingerprint === fingerprint,
                );
          if (acknowledged)
            return { records, result: { saved: acknowledged, reconcile: "accepted" } };
          const latest = latestAttempt(records, record.draftId, record);
          if (latest && sameInput(latest.admission.request, record.admission.request)) {
            return {
              records: clearRefusal(records, latest),
              result: { saved: latest, reconcile: true },
            };
          }
          if (latest && !latest.validationRefused) {
            throw OrbitLaunchCopyError.fromCopy(
              msg("Resolve the previous Orbit submission before sending this edited draft."),
            );
          }
          const previous = records.find(
            (row) =>
              row.draftId === record.draftId &&
              row.superseded &&
              sameInput(row.admission.request, record.admission.request),
          );
          if (previous)
            throw OrbitLaunchCopyError.fromCopy(
              msg("Orbit already refused this request. Change the draft before sending."),
            );
          const archive =
            latest === undefined
              ? records
              : records.map((row) =>
                  row === latest ? ({ ...row, superseded: true } as const) : row,
                );
          return { records: [...archive, record], result: { saved: record, reconcile: false } };
        });
        return reconcile === "accepted" ? submit(saved, reconcile) : send(saved, reconcile);
      });
    },
    draft: (draftId: string, scope: OrbitLaunchScope) =>
      update((records) => ({ records, result: latestAttempt(records, draftId, scope) })),
    pending: ({ profileId, nodeId }: OrbitLaunchScope) =>
      update((records) => ({
        records,
        result: records.filter(
          (r) =>
            r.profileId === profileId &&
            r.nodeId === nodeId &&
            r.acknowledgedFingerprint === undefined,
        ),
      })),
    subscribe: (listener: () => void) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    acknowledge: remove,
    replay(record: OrbitLaunchSubmission) {
      return withDraft(record.draftId, async () => {
        const saved = await update((records) => {
          const latest = latestAttempt(records, record.draftId, record);
          if (latest?.admission.id !== record.admission.id) {
            throw OrbitLaunchCopyError.fromCopy(msg("This submission was already handled."));
          }
          return { records: clearRefusal(records, latest), result: latest };
        });
        return send(saved, true);
      });
    },
  };
}

function launchInput(request: OrbitLaunchRequest): string {
  return JSON.stringify({
    ...request,
    expected_profile_id: undefined,
    expected_node_id: undefined,
    command_id: undefined,
    thread_id: undefined,
    message_id: undefined,
  });
}

function acknowledgedInput(request: OrbitLaunchRequest): string {
  // Selecting a workspace in another window does not change the draft revision.
  const { workspace_id: _, ...draft } = request;
  return launchInput(draft);
}

function sameInput(a: OrbitLaunchRequest, b: OrbitLaunchRequest): boolean {
  return launchInput(a) === launchInput(b);
}

type LegacyOrbitCompletion = {
  readonly instanceId: number;
  readonly status: string;
  readonly retryable: boolean;
  readonly error: string | null;
} & (
  | { readonly operationId: number; readonly retryKey: null }
  | { readonly operationId: null; readonly retryKey: string }
);
export interface LegacyOrbitLaunch {
  readonly id: string;
  readonly project: string;
  readonly prompt: string | null;
  readonly threadId: string | null;
  readonly environmentId: string | null;
  readonly completion: LegacyOrbitCompletion | null;
}

function rowsInLegacyArchive(raw: string): unknown[] {
  const data: unknown = JSON.parse(raw);
  if (!Array.isArray(data))
    throw OrbitLaunchCopyError.fromCopy(msg("Could not read the previous Orbit starts."));
  return data;
}

function legacyCompletion(
  row: Record<string, unknown> & { id: string },
): LegacyOrbitCompletion | null {
  if (
    typeof row.instanceId !== "number" ||
    !Number.isSafeInteger(row.instanceId) ||
    row.instanceId <= 0 ||
    row.completionStatus === "succeeded"
  )
    return null;
  const preview = {
    instanceId: row.instanceId,
    status: typeof row.completionStatus === "string" ? row.completionStatus : "unknown",
    error: typeof row.completionErrorDetail === "string" ? row.completionErrorDetail : null,
  };
  if (
    typeof row.completionOperationId === "number" &&
    Number.isSafeInteger(row.completionOperationId) &&
    row.completionOperationId > 0
  ) {
    return {
      ...preview,
      operationId: row.completionOperationId,
      retryKey: null,
      retryable: row.completionRetryable === true,
    };
  }
  const prefix = `conn-thread-start:${row.id}:complete:`;
  if (
    row.completionOperationId === null &&
    typeof row.completionKey === "string" &&
    row.completionKey.startsWith(prefix) &&
    /^\d+$/.test(row.completionKey.slice(prefix.length))
  ) {
    return { ...preview, operationId: null, retryKey: row.completionKey, retryable: true };
  }
  return null;
}

export function readLegacyOrbitLaunches(raw: string | null): readonly LegacyOrbitLaunch[] {
  if (raw === null) return [];
  return rowsInLegacyArchive(raw).flatMap((value) => {
    if (!value || typeof value !== "object" || !("id" in value) || typeof value.id !== "string")
      return [];
    const row = value as Record<string, unknown> & { id: string };
    const sent = typeof row.sentAt === "number";
    const completion = sent ? legacyCompletion(row) : null;
    const prompt = !sent && typeof row.message === "string" ? row.message : null;
    if (prompt === null && completion === null) return [];
    return [
      {
        id: row.id,
        project: typeof row.projectSlug === "string" ? row.projectSlug : "Orbit",
        prompt,
        threadId: typeof row.threadId === "string" ? row.threadId : null,
        environmentId: typeof row.environmentId === "string" ? row.environmentId : null,
        completion,
      },
    ];
  });
}

function isRetryableLegacyPreview(operation: OrbitGatewayOperation): boolean {
  return (
    operation.recoveryRetryable === true &&
    (operation.status === "failed" ||
      operation.status === "interrupted" ||
      operation.status === "cancelled")
  );
}

/** Migration only. An explicit preview Retry never sends a thread or prompt. */
export async function updateLegacyOrbitPreview(
  client: Pick<OrbitGatewayClient, "operation" | "completeInstance">,
  completion: LegacyOrbitCompletion,
  action: "refresh" | "retry",
): Promise<OrbitGatewayOperation> {
  const check = (operation: OrbitGatewayOperation) => {
    if (operation.kind !== "instance.complete" || operation.targetId !== completion.instanceId) {
      throw OrbitLaunchCopyError.fromCopy(msg("Orbit returned a different preview operation."));
    }
    return operation;
  };
  if (completion.operationId === null) {
    if (action === "refresh")
      throw OrbitLaunchCopyError.fromCopy(msg("Resume the saved preview retry first."));
    return check(await client.completeInstance(completion.instanceId, completion.retryKey));
  }
  const current = check(await client.operation(completion.operationId));
  if (current.id !== completion.operationId)
    throw OrbitLaunchCopyError.fromCopy(msg("Orbit returned a different preview operation."));
  if (action === "refresh" || !isRetryableLegacyPreview(current)) return current;
  return check(
    await client.completeInstance(completion.instanceId, `conn:legacy-preview:${current.id}`),
  );
}

export function recordLegacyOrbitPreview(
  raw: string,
  row: LegacyOrbitLaunch,
  operation: OrbitGatewayOperation,
): string {
  const completion = row.completion;
  return JSON.stringify(
    rowsInLegacyArchive(raw).map((entry) => {
      if (
        completion === null ||
        !entry ||
        typeof entry !== "object" ||
        !("id" in entry) ||
        entry.id !== row.id
      )
        return entry;
      const saved = legacyCompletion(entry as Record<string, unknown> & { id: string });
      if (
        saved === null ||
        saved.instanceId !== completion.instanceId ||
        saved.operationId !== completion.operationId ||
        saved.retryKey !== completion.retryKey
      )
        return entry;
      return {
        ...entry,
        completionOperationId: operation.id,
        completionKey: null,
        completionStatus: operation.status,
        completionRetryable: isRetryableLegacyPreview(operation),
        completionErrorDetail: operation.error?.detail ?? null,
      };
    }),
  );
}

/** Remove only the entry the user explicitly resolved, retaining opaque rows from older versions. */
export function resolveLegacyOrbitLaunch(raw: string, id: string): string | null {
  const remaining = rowsInLegacyArchive(raw).filter(
    (row: unknown) => !(row && typeof row === "object" && "id" in row && row.id === id),
  );
  return remaining.length === 0 ? null : JSON.stringify(remaining);
}
