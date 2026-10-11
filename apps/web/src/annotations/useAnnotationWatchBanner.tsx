import { useMemo } from "react";

import type { ComposerBannerStackItem } from "../components/chat/ComposerBannerStack";
import { Button } from "../components/ui/button";
import { countAnnotations } from "./annotatorQueue";
import { useAnnotationWatch, useAnnotationWatchStore } from "./annotationWatchStore";
import { useAnnotatorQueue } from "./useAnnotatorQueue";

/** The composer strip shown while a thread watches an annotator. */
export function useAnnotationWatchBanner(threadKey: string | null): ComposerBannerStackItem | null {
  const watch = useAnnotationWatch(threadKey ?? "");
  const setWatching = useAnnotationWatchStore((state) => state.setWatching);
  const endpoint = useMemo(
    () =>
      watch === null ? null : { annotationsUrl: watch.annotationsUrl, injectUrl: "", origin: "" },
    [watch],
  );
  const queue = useAnnotatorQueue(endpoint);
  const annotations = queue.annotations;
  return useMemo(() => {
    if (threadKey === null || watch === null) return null;
    const counts = countAnnotations(annotations ?? []);
    const parts = [
      counts.working > 0 ? `${counts.working} working` : null,
      counts.waiting > 0 ? `${counts.waiting} waiting` : null,
      counts.question > 0
        ? `${counts.question} ${counts.question === 1 ? "question" : "questions"}`
        : null,
    ].filter((part): part is string => part !== null);
    return {
      id: `annotation-watch:${threadKey}`,
      variant: "default",
      priority: "activity",
      icon: (
        <span
          className="size-1.5 animate-status-pulse rounded-full bg-success"
          aria-hidden="true"
        />
      ),
      title: "Watching annotations",
      description: queue.unreachable
        ? "Annotator unreachable"
        : annotations === null
          ? "Loading annotations"
          : parts.join(" · ") || "Queue empty",
      actions: (
        <Button size="xs" variant="ghost" onClick={() => setWatching(threadKey, null)}>
          Stop
        </Button>
      ),
    };
  }, [annotations, queue.unreachable, setWatching, threadKey, watch]);
}
