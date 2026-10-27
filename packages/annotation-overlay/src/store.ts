import { createStore } from "./core/store";
import type { Annotation } from "./types";

// The server owns the annotations; this keeps the open pins of every path this page saw,
// so a client-side navigation shows its pins before the next list arrives.
const pinsByPath = new Map<string, Annotation[]>();
const dismissed = new Set<string>();

/** Open pins across every path of this site. */
export const openPinCount = createStore(0);

function publishCount(): void {
  let count = 0;
  for (const pins of pinsByPath.values()) count += pins.length;
  openPinCount.setState(count);
}

export function loadAnnotations(pathname: string = window.location.pathname): Annotation[] {
  return (pinsByPath.get(pathname) ?? []).filter((annotation) => !dismissed.has(annotation.id));
}

export function saveAnnotations(
  annotations: Annotation[],
  pathname: string = window.location.pathname,
): void {
  if (annotations.length === 0) pinsByPath.delete(pathname);
  else pinsByPath.set(pathname, annotations);
  publishCount();
}

/** Every pin this page knows, across paths. */
export function allAnnotations(): Annotation[] {
  return [...pinsByPath.values()].flat().filter((annotation) => !dismissed.has(annotation.id));
}

export function createAnnotationId(): string {
  return (
    globalThis.crypto?.randomUUID?.() ?? `ann-${Date.now()}-${Math.random().toString(16).slice(2)}`
  );
}

export function clearStoredAnnotations(): void {
  for (const annotation of allAnnotations()) dismissed.add(annotation.id);
  pinsByPath.clear();
  publishCount();
}

/** A successful server list owns all pins; drops the ones it no longer has. */
export function reconcileServerAnnotations(presentIds: ReadonlySet<string>): string[] {
  const removed: string[] = [];
  for (const [path, pins] of pinsByPath) {
    const kept = pins.filter(
      (pin) => presentIds.has(pin.id) || pin.revision === undefined || pin.delivery === "error",
    );
    removed.push(...pins.filter((pin) => !kept.includes(pin)).map((pin) => pin.id));
    if (kept.length === 0) pinsByPath.delete(path);
    else pinsByPath.set(path, kept);
  }
  publishCount();
  return removed;
}

/** Ids removed by this page stay hidden even if a list from before the removal arrives. */
export function isDismissed(id: string): boolean {
  return dismissed.has(id);
}

export function dismissAnnotations(ids: ReadonlyArray<string>): void {
  for (const id of ids) dismissed.add(id);
}

/** Test seam: forget every pin and dismissal. */
export function resetPinStore(): void {
  pinsByPath.clear();
  dismissed.clear();
  publishCount();
}
