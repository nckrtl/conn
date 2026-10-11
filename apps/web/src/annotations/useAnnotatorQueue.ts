import { useEffect, useState } from "react";

import { type AnnotatorEndpoint, type AnnotatorRecord, fetchAnnotations } from "./annotatorQueue";

const FALLBACK_POLL_MS = 15_000;

export interface AnnotatorQueueState {
  /** `null` until a fetch for this URL succeeds. A later failure keeps the last list. */
  readonly annotations: AnnotatorRecord[] | null;
  /** The URL did not answer. Distinct from "not loaded yet". */
  readonly unreachable: boolean;
}

/** A failed fetch keeps the last good list. The first failure stays "not loaded". */
export function applyAnnotationFetch(
  previous: AnnotatorRecord[] | null,
  fetched: AnnotatorRecord[] | null,
): AnnotatorQueueState {
  if (fetched !== null) return { annotations: fetched, unreachable: false };
  return { annotations: previous, unreachable: true };
}

/**
 * Live annotations of one annotator. `annotations` stays `null` until the first
 * successful fetch, including when the page has no annotator. The server's event
 * stream only says "fetch again", so every change is one fetch; a slow poll covers
 * a dropped stream.
 */
export function useAnnotatorQueue(endpoint: AnnotatorEndpoint | null): AnnotatorQueueState {
  const url = endpoint?.annotationsUrl ?? null;
  // Keyed by URL, so a new page never shows the previous page's queue.
  const [loaded, setLoaded] = useState<{
    url: string;
    annotations: AnnotatorRecord[] | null;
    unreachable: boolean;
  } | null>(null);

  useEffect(() => {
    if (url === null) return;
    const controller = new AbortController();
    const load = () =>
      void fetchAnnotations(url, controller.signal).then((annotations) => {
        if (controller.signal.aborted) return;
        setLoaded((current) => {
          const previous = current !== null && current.url === url ? current.annotations : null;
          return { url, ...applyAnnotationFetch(previous, annotations) };
        });
      });
    load();
    let events: EventSource | null = null;
    try {
      events = new EventSource(`${url}/events`);
      events.addEventListener("message", load);
    } catch {
      events = null;
    }
    const timer = setInterval(load, FALLBACK_POLL_MS);
    return () => {
      controller.abort();
      events?.close();
      clearInterval(timer);
    };
  }, [url]);

  if (url === null || loaded === null || loaded.url !== url) {
    return { annotations: null, unreachable: false };
  }
  return { annotations: loaded.annotations, unreachable: loaded.unreachable };
}
