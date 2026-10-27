import { parseScopedThreadKey } from "@t3tools/client-runtime/environment";
import { MessageSquareTextIcon } from "lucide-react";

import type { ComposerBannerStackItem } from "../components/chat/ComposerBannerStack";
import { Button } from "../components/ui/button";
import { countAnnotations, waitingIdsToSend } from "./annotationQueue";
import { useAnnotationWatch, useAnnotationWatchStore } from "./annotationWatchStore";
import { sendAnnotationPrompt } from "./sendAnnotationPrompt";
import { useThreadAnnotations, useThreadAnnotationTarget } from "./useAnnotationQueue";

const EMPTY_IDS: string[] = [];

/**
 * The composer strip for the thread's annotations: "Watching" while Watch is on, otherwise
 * a Send prompt while annotations wait that the thread has not been sent yet.
 */
export function useAnnotationWatchBanner(threadKey: string | null): ComposerBannerStackItem | null {
  const threadRef = threadKey === null ? null : parseScopedThreadKey(threadKey);
  const watch = useAnnotationWatch(threadKey ?? "");
  const threadTarget = useThreadAnnotationTarget(threadRef);
  const setWatching = useAnnotationWatchStore((state) => state.setWatching);
  const lastSentIds = useAnnotationWatchStore((state) =>
    threadKey === null ? EMPTY_IDS : (state.lastSentIdsByThreadKey[threadKey] ?? EMPTY_IDS),
  );
  const { annotations, error } = useThreadAnnotations(threadRef, watch ?? threadTarget);
  if (threadKey === null || threadRef === null) return null;
  const counts = countAnnotations(annotations ?? []);
  if (watch !== null) {
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
      icon: (
        <span
          className="size-1.5 animate-status-pulse rounded-full bg-success"
          aria-hidden="true"
        />
      ),
      title: "Watching annotations",
      description: error ?? (parts.join(" · ") || "Queue empty"),
      actions: (
        <Button size="xs" variant="ghost" onClick={() => setWatching(threadKey, null)}>
          Stop
        </Button>
      ),
    };
  }
  const unsent = waitingIdsToSend({
    watching: true,
    threadIdle: true,
    annotations: annotations ?? [],
    lastSentIds,
  });
  if (annotations === null || unsent.length === 0) return null;
  return {
    id: `annotation-waiting:${threadKey}`,
    variant: "default",
    icon: <MessageSquareTextIcon />,
    title: `${counts.waiting} ${counts.waiting === 1 ? "annotation" : "annotations"} waiting`,
    actions: (
      <Button
        size="xs"
        variant="ghost"
        onClick={() => sendAnnotationPrompt({ threadRef, annotations })}
      >
        Send
      </Button>
    ),
  };
}
