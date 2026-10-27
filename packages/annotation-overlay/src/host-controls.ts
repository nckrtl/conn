import { annotationMode, annotations } from "./state";
import { openPinCount } from "./store";
import { removalError, serviceConnection } from "./sync";

const stores = [
  annotationMode.store,
  annotations.store,
  openPinCount,
  serviceConnection,
  removalError,
];
function snapshot() {
  return {
    active: annotationMode.value,
    /** Open annotations on this site. */
    count: openPinCount.getSnapshot(),
    /** Open annotations on the current page. */
    pageCount: annotations.value.length,
    connection: serviceConnection.getSnapshot(),
    removalError: removalError.getSnapshot(),
  };
}
let cached = snapshot();
/** Stable snapshots can be consumed by any framework, without sharing React. */
export function getAnnotationState() {
  const next = snapshot();
  if (
    Object.keys(next).some(
      (key) => next[key as keyof typeof next] !== cached[key as keyof typeof cached],
    )
  )
    cached = next;
  return cached;
}
export function subscribeAnnotationState(listener: () => void): () => void {
  const unsubscribe = stores.map((store) => store.subscribe(listener));
  return () => unsubscribe.forEach((stop) => stop());
}
