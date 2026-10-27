import type {
  AnnotationRecord,
  EnvironmentId,
  ProjectId,
  ScopedThreadRef,
} from "@t3tools/contracts";

import { useQuietThreadShell } from "../state/entities";
import { previewEnvironment } from "../state/preview";
import { useEnvironmentQuery } from "../state/query";

export interface AnnotationTarget {
  readonly environmentId: EnvironmentId;
  readonly projectId: ProjectId;
}

interface AnnotationQueue {
  /** `null` until the first list arrives. */
  readonly annotations: ReadonlyArray<AnnotationRecord> | null;
  readonly error: string | null;
}

/** Live annotations of one project. Every caller shares one subscription per project. */
export function useAnnotationQueue(target: AnnotationTarget | null): AnnotationQueue {
  const query = useEnvironmentQuery(
    target === null
      ? null
      : previewEnvironment.annotationsLive({
          environmentId: target.environmentId,
          input: { projectId: target.projectId },
        }),
  );
  return { annotations: query.data?.annotations ?? null, error: query.error };
}

/** The project of the thread, which owns the queue the thread works through. */
export function useThreadAnnotationTarget(
  threadRef: ScopedThreadRef | null,
): AnnotationTarget | null {
  const projectId = useQuietThreadShell(threadRef)?.projectId ?? null;
  const environmentId = threadRef?.environmentId ?? null;
  return environmentId === null || projectId === null ? null : { environmentId, projectId };
}
