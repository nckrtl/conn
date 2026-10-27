import { createStore } from "./core/store";
import type { AnnotationTransport } from "./transport";
import {
  allAnnotations,
  dismissAnnotations,
  isDismissed,
  loadAnnotations,
  reconcileServerAnnotations,
  saveAnnotations,
} from "./store";
import type { Annotation } from "./types";

export type AnnotationSync = {
  annotations: Annotation[];
  resolvedIds: string[];
  inProgressIds: string[];
};
export type AnnotationEventHandlers = {
  onCreated?: (annotations: Annotation[]) => void;
  onResolved?: (ids: string[]) => void;
  onProgress?: (ids: string[]) => void;
};

export const UNAVAILABLE_MESSAGE = "Annotations are not available on this page.";

/** "Unavailable": this page has no annotation transport; "Disconnected": the last read failed. */
export const serviceConnection = createStore<
  "Connecting" | "Connected" | "Disconnected" | "Unavailable"
>("Unavailable");
export const removalError = createStore("");

let transport: AnnotationTransport | undefined;
let generation = 0;
const revisions = new Map<string, number>();
const configurationListeners = new Set<() => void>();

/** Use `next` for every read and write; undefined leaves annotations unavailable. */
export function configureAnnotationService(next: AnnotationTransport | undefined): void {
  if (next === transport) return;
  transport = next;
  generation++;
  revisions.clear();
  removalError.setState("");
  serviceConnection.setState(transport ? "Connecting" : "Unavailable");
  configurationListeners.forEach((restart) => restart());
}

/** Maps a server record onto the overlay's statuses: todo, in_progress and done. */
export function parseAnnotation(value: unknown): Annotation | null {
  if (!value || typeof value !== "object") return null;
  const item = value as Record<string, unknown>;
  if (typeof item.id !== "string" || !item.id || typeof item.comment !== "string") return null;
  return {
    ...item,
    status: item.status === "todo" ? "pending" : item.status === "done" ? "resolved" : item.status,
  } as Annotation;
}

/** Only browser annotations of this site get pins; device ones and other sites stay out. */
function belongsToSite(annotation: Annotation & { source?: unknown }): boolean {
  if (annotation.source !== undefined && annotation.source !== "browser") return false;
  if (!annotation.url) return true;
  try {
    return new URL(annotation.url, window.location.href).origin === window.location.origin;
  } catch {
    return false;
  }
}

function receive(value: unknown): Annotation | null {
  const annotation = parseAnnotation(value);
  if (!annotation || isDismissed(annotation.id) || !belongsToSite(annotation)) return null;
  if (
    typeof annotation.revision !== "number" ||
    annotation.revision < (revisions.get(annotation.id) ?? 0)
  )
    return null;
  revisions.set(annotation.id, annotation.revision);
  // Update every path, including pages not mounted now, so a navigation shows the latest.
  const path = annotation.pathname || window.location.pathname;
  const existing = loadAnnotations(path).filter((a) => a.id !== annotation.id);
  saveAnnotations(
    annotation.status === "resolved" || annotation.status === "cancelled"
      ? existing
      : [...existing, annotation],
    path,
  );
  return annotation;
}

export async function pushAnnotation(annotation: Annotation): Promise<Annotation | null> {
  const pathname = annotation.pathname ?? window.location.pathname;
  const working: Annotation = {
    ...annotation,
    url: annotation.url ?? window.location.href,
    pathname,
    status: annotation.status ?? "pending",
  };
  const existing = loadAnnotations(pathname).filter((a) => a.id !== annotation.id);
  saveAnnotations([...existing, working], pathname);
  const fail = (syncError: string): Annotation => {
    const failed = { ...working, delivery: "error" as const, syncError };
    if (!isDismissed(failed.id))
      saveAnnotations(
        [...loadAnnotations(pathname).filter((a) => a.id !== failed.id), failed],
        pathname,
      );
    return failed;
  };
  if (!transport) return fail(UNAVAILABLE_MESSAGE);
  const current = generation;
  try {
    const result = await transport.submit(working);
    if (current !== generation) return working;
    return receive(result);
  } catch (error) {
    return fail(error instanceof Error ? error.message : "Could not send the annotation.");
  }
}

function summary(annotations: Annotation[]): AnnotationSync {
  return {
    annotations,
    resolvedIds: annotations
      .filter((a) => a.status === "resolved" || a.status === "cancelled")
      .map((a) => a.id),
    inProgressIds: annotations.filter((a) => a.status === "in_progress").map((a) => a.id),
  };
}

export async function fetchAnnotationSync(): Promise<AnnotationSync> {
  const current = generation;
  if (transport) {
    try {
      const records = await transport.list();
      if (current !== generation) return summary([]);
      if (!Array.isArray(records)) throw new Error("Invalid annotation list");
      serviceConnection.setState("Connected");
      const presentIds = new Set(
        records.flatMap((value) => {
          const parsed = parseAnnotation(value);
          return parsed && parsed.status !== "resolved" ? [parsed.id] : [];
        }),
      );
      const missingIds = reconcileServerAnnotations(presentIds);
      const snapshot = summary(records.flatMap((value) => receive(value) ?? []));
      snapshot.resolvedIds.push(...missingIds);
      return snapshot;
    } catch {
      if (current === generation) serviceConnection.setState("Disconnected");
      // Keep the pins visible while the server cannot be reached.
    }
  }
  return summary(loadAnnotations(window.location.pathname));
}

export function subscribeAnnotationEvents(handlers: AnnotationEventHandlers): () => void {
  let stop = () => {};
  const start = () => {
    stop();
    const target = transport;
    if (!target) return;
    let closed = false;
    let fetching = false;
    let again = false;
    const refresh = async () => {
      if (closed) return;
      if (fetching) {
        again = true;
        return;
      }
      fetching = true;
      const result = await fetchAnnotationSync();
      fetching = false;
      if (closed) return;
      handlers.onCreated?.(result.annotations);
      handlers.onProgress?.(result.inProgressIds);
      handlers.onResolved?.(result.resolvedIds);
      if (again) {
        again = false;
        void refresh();
      }
    };
    const unsubscribe = target.subscribe(() => void refresh());
    const onVisible = () => {
      if (document.visibilityState !== "hidden") void refresh();
    };
    document.addEventListener("visibilitychange", onVisible);
    stop = () => {
      closed = true;
      document.removeEventListener("visibilitychange", onVisible);
      unsubscribe();
    };
    void refresh();
  };
  configurationListeners.add(start);
  start();
  return () => {
    configurationListeners.delete(start);
    stop();
  };
}

/** Removes the annotations from the server, then hides their pins. */
export async function removeAnnotations(ids: ReadonlyArray<string>): Promise<boolean> {
  removalError.setState("");
  if (ids.length === 0) return true;
  // Pins that never reached the server have nothing to remove there.
  const stored = ids.filter((id) => revisions.has(id));
  if (stored.length > 0) {
    if (!transport) {
      removalError.setState(UNAVAILABLE_MESSAGE);
      return false;
    }
    try {
      await transport.remove(stored);
    } catch {
      removalError.setState(
        ids.length === 1
          ? "Could not delete the annotation. Try again."
          : "Could not remove the annotations. Try again.",
      );
      return false;
    }
  }
  dismissAnnotations(ids);
  return true;
}

/** Removes every annotation of this site, or only those on `pathname`. */
export function clearSyncedAnnotations(pathname?: string): Promise<boolean> {
  const pins = pathname === undefined ? allAnnotations() : loadAnnotations(pathname);
  return removeAnnotations(pins.map((annotation) => annotation.id));
}

export async function deleteSyncedAnnotation(id: string): Promise<boolean> {
  if (!(await removeAnnotations([id]))) return false;
  const pathname = window.location.pathname;
  saveAnnotations(
    loadAnnotations(pathname).filter((annotation) => annotation.id !== id),
    pathname,
  );
  return true;
}
