import * as Schema from "effect/Schema";

import {
  OrbitGatewayError,
  type OrbitGatewayClient,
  type OrbitGatewayOperation,
} from "./client.ts";
import type {
  OrbitLaunch,
  OrbitLaunchAdmission,
  OrbitLaunchRequest,
  OrbitLaunchScope,
} from "./launches.ts";

const isGatewayError = Schema.is(OrbitGatewayError);

export interface OrbitLaunchSubmission extends OrbitLaunchScope {
  readonly draftId: string;
  readonly admission: OrbitLaunchAdmission;
}

export interface OrbitLaunchSubmissionStorage {
  readonly lock?: <T>(work: () => Promise<T>) => Promise<T>;
  readonly load: () => Promise<readonly OrbitLaunchSubmission[]>;
  readonly save: (records: readonly OrbitLaunchSubmission[]) => Promise<void>;
}

/** A journal for the admission response only. It never follows or runs the accepted operation. */
export function createOrbitLaunchSubmissions(
  storage: OrbitLaunchSubmissionStorage,
  submit: (record: OrbitLaunchSubmission, reconcile: boolean) => Promise<OrbitLaunch>,
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

  function remove(id: string) {
    return update((records) => ({
      records: records.some(({ admission }) => admission.id === id)
        ? records.filter(({ admission }) => admission.id !== id)
        : records,
      result: undefined,
    }));
  }

  const inFlight = new Map<string, Promise<OrbitLaunch>>();
  function send(record: OrbitLaunchSubmission, reconcile: boolean): Promise<OrbitLaunch> {
    const id = record.admission.id;
    const current = inFlight.get(id);
    if (current) return current;
    const pending = (async () => {
      try {
        return await submit(record, reconcile);
      } catch (error) {
        if (!reconcile && isGatewayError(error) && [400, 403, 404, 422].includes(error.status))
          await remove(id);
        throw error;
      }
    })().finally(() => {
      inFlight.delete(id);
    });
    inFlight.set(id, pending);
    return pending;
  }

  return {
    async submit(record: OrbitLaunchSubmission) {
      const saved = await update((records) => {
        const previous = records.find(
          (entry) =>
            entry.profileId === record.profileId &&
            entry.nodeId === record.nodeId &&
            entry.draftId === record.draftId,
        );
        if (previous === undefined)
          return { records: [...records, record], result: { saved: record, replay: false } };
        if (!sameInput(previous.admission.request, record.admission.request)) {
          throw new Error(
            "Resolve the previous Orbit submission before sending this edited draft.",
          );
        }
        return { records, result: { saved: previous, replay: true } };
      });
      return send(saved.saved, saved.replay);
    },
    pending: ({ profileId, nodeId }: OrbitLaunchScope) =>
      update((records) => ({
        records,
        result: records.filter((r) => r.profileId === profileId && r.nodeId === nodeId),
      })),
    subscribe: (listener: () => void) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    acknowledge: remove,
    async replay(record: OrbitLaunchSubmission) {
      const saved = await update((records) => ({
        records,
        result: records.find(
          (row) =>
            row.admission.id === record.admission.id &&
            row.profileId === record.profileId &&
            row.nodeId === record.nodeId,
        ),
      }));
      if (saved === undefined) throw new Error("This submission was already handled.");
      return send(saved, true);
    },
  };
}

function sameInput(a: OrbitLaunchRequest, b: OrbitLaunchRequest): boolean {
  const input = (r: OrbitLaunchRequest) => ({
    ...r,
    command_id: undefined,
    thread_id: undefined,
    message_id: undefined,
  });
  return JSON.stringify(input(a)) === JSON.stringify(input(b));
}

interface LegacyOrbitCompletion {
  readonly instanceId: number;
  readonly operationId: number;
  readonly status: string;
  readonly retryable: boolean;
  readonly error: string | null;
}
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
  if (!Array.isArray(data)) throw new Error("Could not read the previous Orbit starts.");
  return data;
}

function legacyCompletion(row: Record<string, unknown>): LegacyOrbitCompletion | null {
  if (
    typeof row.instanceId !== "number" ||
    typeof row.completionOperationId !== "number" ||
    !Number.isSafeInteger(row.instanceId) ||
    row.instanceId <= 0 ||
    !Number.isSafeInteger(row.completionOperationId) ||
    row.completionOperationId <= 0 ||
    row.completionStatus === "succeeded"
  )
    return null;
  return {
    instanceId: row.instanceId,
    operationId: row.completionOperationId,
    status: typeof row.completionStatus === "string" ? row.completionStatus : "unknown",
    retryable: row.completionRetryable === true,
    error: typeof row.completionErrorDetail === "string" ? row.completionErrorDetail : null,
  };
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
      throw new Error("Orbit returned a different preview operation.");
    }
    return operation;
  };
  const current = check(await client.operation(completion.operationId));
  if (current.id !== completion.operationId)
    throw new Error("Orbit returned a different preview operation.");
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
  return JSON.stringify(
    rowsInLegacyArchive(raw).map((entry) => {
      if (
        !entry ||
        typeof entry !== "object" ||
        !("id" in entry) ||
        entry.id !== row.id ||
        !("completionOperationId" in entry) ||
        entry.completionOperationId !== row.completion?.operationId
      )
        return entry;
      return {
        ...entry,
        completionOperationId: operation.id,
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
