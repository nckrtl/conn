import type {
  AnnotationRecord,
  EnvironmentId,
  ProjectId,
  ScopedThreadRef,
} from "@t3tools/contracts";
import { useShallow } from "zustand/react/shallow";

import { deviceAnnotationPathname } from "../components/device/deviceAnnotations";
import { useThreadPreviewState } from "../previewStateStore";
import { selectThreadRightPanelState, useRightPanelStore } from "../rightPanelStore";
import { useQuietThreadShell } from "../state/entities";
import { previewEnvironment } from "../state/preview";
import { useEnvironmentQuery } from "../state/query";
import { type AnnotationScope, annotationsInScope, pageOrigin } from "./annotationQueue";

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

/** The origins open in the thread's browser tabs and the devices open in its Device panel. */
export function useThreadAnnotationScope(threadRef: ScopedThreadRef | null): AnnotationScope {
  const { sessions } = useThreadPreviewState(threadRef);
  const devicePathnames = useRightPanelStore(
    useShallow((state) =>
      selectThreadRightPanelState(state.byThreadKey, threadRef).surfaces.flatMap((surface) =>
        surface.kind === "device" && surface.target !== undefined
          ? [deviceAnnotationPathname(surface.target.hostId, surface.target.deviceId)]
          : [],
      ),
    ),
  );
  const origins = new Set<string>();
  for (const session of Object.values(sessions)) {
    const origin = session.navStatus._tag === "Idle" ? null : pageOrigin(session.navStatus.url);
    if (origin !== null) origins.add(origin);
  }
  return { origins, devicePathnames: new Set(devicePathnames) };
}

/** The project queue narrowed to what the thread has open (see `annotationsInScope`). */
export function useThreadAnnotations(
  threadRef: ScopedThreadRef | null,
  target: AnnotationTarget | null,
): AnnotationQueue {
  const queue = useAnnotationQueue(target);
  const scope = useThreadAnnotationScope(threadRef);
  return {
    annotations: queue.annotations === null ? null : annotationsInScope(queue.annotations, scope),
    error: queue.error,
  };
}

/** The project of the thread, which owns the queue the thread works through. */
export function useThreadAnnotationTarget(
  threadRef: ScopedThreadRef | null,
): AnnotationTarget | null {
  const projectId = useQuietThreadShell(threadRef)?.projectId ?? null;
  const environmentId = threadRef?.environmentId ?? null;
  return environmentId === null || projectId === null ? null : { environmentId, projectId };
}
