import { scopedThreadKey } from "@t3tools/client-runtime/environment";
import type { ScopedThreadRef } from "@t3tools/contracts";
import {
  BrushCleaningIcon,
  CheckIcon,
  CircleIcon,
  MessageCircleQuestionIcon,
  MessageSquareTextIcon,
  MicIcon,
  SendIcon,
} from "lucide-react";
import { useCallback, useEffect, useEffectEvent, useId, useMemo, useState } from "react";

import { Badge } from "~/components/ui/badge";
import { Button } from "~/components/ui/button";
import { DraftInput } from "~/components/ui/draft-input";
import { Kbd } from "~/components/ui/kbd";
import { Popover, PopoverPopup, PopoverTrigger } from "~/components/ui/popover";
import { Spinner } from "~/components/ui/spinner";
import { Switch } from "~/components/ui/switch";
import { Tooltip, TooltipPopup, TooltipTrigger } from "~/components/ui/tooltip";
import { useClientSettings, useUpdatePrimarySettings } from "~/hooks/useSettings";
import { cn } from "~/lib/utils";

import {
  type AnnotationQueueState,
  annotationState,
  annotatorEndpointForPage,
  clearDoneAnnotations,
  countAnnotations,
  openAnnotationCount,
  overlayBootstrapScript,
  overlayConfigureScript,
  overlaySetModeScript,
} from "./annotatorQueue";
import { useAnnotationWatch, useAnnotationWatchStore } from "./annotationWatchStore";
import { sendAnnotationPrompt } from "./sendAnnotationPrompt";
import { useAnnotatorQueue } from "./useAnnotatorQueue";

type PreviewWebview = HTMLElement & {
  executeJavaScript?: (code: string) => Promise<unknown>;
};

function runInPage(runtimeTabId: string, code: string): void {
  // The element is replaced after a crash, so look it up on every call.
  const webview = document.querySelector<PreviewWebview>(
    `webview[data-preview-tab="${CSS.escape(runtimeTabId)}"]`,
  );
  if (!webview?.executeJavaScript) return;
  // Electron throws synchronously until the webview is attached and dom-ready; the next
  // page load runs the bootstrap again, so a skipped call is safe.
  try {
    void webview.executeJavaScript(code).catch(() => undefined);
  } catch {
    // Not ready yet.
  }
}

/**
 * Browser toolbar control for pages served with an Orbit annotator. Hover shows the
 * shared queue; a click turns annotation mode on or off in the page.
 */
export function BrowserAnnotationControl({
  threadRef,
  runtimeTabId,
  pageUrl,
  loading,
}: {
  threadRef: ScopedThreadRef;
  runtimeTabId: string | null;
  pageUrl: string | null;
  loading: boolean;
}) {
  const endpoint = useMemo(
    () => (pageUrl === null ? null : annotatorEndpointForPage(pageUrl)),
    [pageUrl],
  );
  const annotations = useAnnotatorQueue(endpoint).annotations;
  const available = annotations !== null;
  const threadKey = scopedThreadKey(threadRef);
  const watch = useAnnotationWatch(threadKey);
  const setWatching = useAnnotationWatchStore((state) => state.setWatching);
  const [annotating, setAnnotating] = useState(false);
  const watchSwitchId = useId();
  const dictationStartUrl = useClientSettings((settings) => settings.annotationDictationUrl);
  const dictationStopUrl = useClientSettings((settings) => settings.annotationDictationStopUrl);
  const updateSettings = useUpdatePrimarySettings();
  const dictation = useMemo(
    () => ({ startUrl: dictationStartUrl, stopUrl: dictationStopUrl }),
    [dictationStartUrl, dictationStopUrl],
  );

  // Restoring the mode must not re-run the page-load effect when the mode toggles.
  const restoreMode = useEffectEvent((tabId: string) => {
    if (annotating) runInPage(tabId, overlaySetModeScript(true));
  });
  const bootstrap = useEffectEvent((tabId: string, target: NonNullable<typeof endpoint>) =>
    runInPage(tabId, overlayBootstrapScript(target, dictation)),
  );
  // Each page load (and reload) starts without the overlay; load it and restore the mode.
  useEffect(() => {
    if (!available || loading || endpoint === null || runtimeTabId === null) return;
    bootstrap(runtimeTabId, endpoint);
    // The overlay mounts once its script has run; give it a moment.
    const timer = setTimeout(() => restoreMode(runtimeTabId), 400);
    return () => clearTimeout(timer);
  }, [available, endpoint, loading, runtimeTabId]);

  // Changed dictation settings apply to the running overlay without a reload.
  useEffect(() => {
    if (runtimeTabId !== null) runInPage(runtimeTabId, overlayConfigureScript(dictation));
  }, [dictation, runtimeTabId]);

  const toggleAnnotating = useCallback(() => {
    if (runtimeTabId === null) return;
    const next = !annotating;
    setAnnotating(next);
    runInPage(runtimeTabId, overlaySetModeScript(next));
  }, [annotating, runtimeTabId]);

  if (annotations === null || endpoint === null || runtimeTabId === null) return null;

  const counts = countAnnotations(annotations);
  const open = openAnnotationCount(counts);
  const watching = watch !== null && watch.annotationsUrl === endpoint.annotationsUrl;

  return (
    <Popover
      onOpenChange={(_open, details) => {
        // Hover shows the queue; a click toggles annotation mode instead.
        if (details.reason === "trigger-press") details.cancel();
      }}
    >
      <PopoverTrigger
        openOnHover
        delay={150}
        closeDelay={150}
        render={
          <Button
            variant={annotating ? "secondary" : "ghost"}
            size="icon-xs"
            aria-label={`${annotating ? "Stop annotating" : "Annotate page"}, ${open} open`}
            aria-pressed={annotating ? "true" : "false"}
            type="button"
            className="relative"
            onClick={toggleAnnotating}
          />
        }
      >
        <MessageSquareTextIcon className={cn(annotating && "text-primary")} />
        {open > 0 ? (
          <span
            aria-hidden
            className="absolute -top-1 -right-1 flex h-3.5 min-w-3.5 items-center justify-center rounded-full bg-info px-1 text-3xs font-semibold tabular-nums text-white"
          >
            {open}
          </span>
        ) : null}
      </PopoverTrigger>
      <PopoverPopup align="end" sideOffset={6} width="lg" padding="none">
        <div className="flex items-start justify-between gap-3 px-3 pt-3 pb-2">
          <div className="min-w-0">
            <div className="text-sm font-medium">Annotations</div>
            <div className="truncate text-xs text-muted-foreground">
              {endpoint.origin} · {annotating ? "click to stop annotating" : "click to annotate"}{" "}
              <Kbd>⌘⇧A</Kbd>
            </div>
          </div>
          <div className="flex shrink-0 items-center gap-1">
            {watching ? (
              <Badge variant="success" size="sm">
                Watching
              </Badge>
            ) : null}
            {counts.done > 0 ? (
              <Tooltip>
                <TooltipTrigger
                  render={
                    <Button
                      variant="ghost"
                      size="icon-xs"
                      aria-label={`Clear ${counts.done} done`}
                      type="button"
                      onClick={() =>
                        void clearDoneAnnotations(endpoint.annotationsUrl, annotations)
                      }
                    />
                  }
                >
                  <BrushCleaningIcon />
                </TooltipTrigger>
                <TooltipPopup>{`Clear ${counts.done} done`}</TooltipPopup>
              </Tooltip>
            ) : null}
          </div>
        </div>
        {annotations.length === 0 ? (
          <p className="border-t border-border/60 px-3 py-3 text-xs text-muted-foreground">
            No annotations yet. Click the button, then click an element on the page.
          </p>
        ) : (
          <ol
            role="list"
            className="max-h-80 overflow-y-auto border-t border-border/60 p-1.5 text-sm"
          >
            {annotations.map((annotation) => {
              const state = annotationState(annotation);
              return (
                <li
                  key={annotation.id}
                  className="grid grid-cols-[auto_minmax(0,1fr)_auto] items-start gap-x-2.5 rounded-md px-1.5 py-1.5 hover:bg-accent"
                >
                  <span
                    className={cn(
                      "mt-0.5 flex size-4.5 items-center justify-center rounded-full text-3xs font-semibold tabular-nums",
                      state === "done" ? "bg-muted text-muted-foreground" : "bg-info text-white",
                    )}
                  >
                    {annotation.number}
                  </span>
                  <div className="min-w-0">
                    <div
                      className={cn(
                        "truncate leading-snug",
                        state === "done" && "text-muted-foreground",
                      )}
                    >
                      {annotation.comment}
                    </div>
                    <div className="mt-0.5 truncate text-xs text-muted-foreground/70">
                      {annotation.summary ?? annotation.element ?? annotation.pathname}
                      {annotation.source ? ` · ${annotation.source}` : ""}
                    </div>
                  </div>
                  <span className="mt-0.5 text-xs">
                    <QueueStateLabel state={state} />
                  </span>
                </li>
              );
            })}
          </ol>
        )}
        <div className="border-t border-border/60 px-3 py-2.5">
          {watching ? (
            <p className="text-xs text-muted-foreground">
              New annotations go to this thread when it is idle.
              {counts.question > 0 ? " Questions wait for your answer in the thread." : ""}
            </p>
          ) : (
            <Button
              size="xs"
              className="w-full justify-center"
              disabled={counts.waiting === 0}
              onClick={() =>
                sendAnnotationPrompt({
                  threadRef,
                  annotationsUrl: endpoint.annotationsUrl,
                  annotations,
                })
              }
            >
              <SendIcon />
              {counts.waiting === 0 ? "Nothing waiting" : `Send ${counts.waiting} to this thread`}
            </Button>
          )}
        </div>
        <div className="flex items-center gap-2 border-t border-border/60 px-3 py-2 text-xs">
          <MicIcon aria-hidden className="size-3.5 shrink-0 text-muted-foreground" />
          <span className="shrink-0 font-medium text-muted-foreground">Dictation</span>
          <DraftInput
            size="sm"
            className="min-w-0 flex-1"
            value={dictationStartUrl}
            onCommit={(next) => updateSettings({ annotationDictationUrl: next.trim() })}
            placeholder="Off"
            spellCheck={false}
            aria-label="Annotation dictation URL"
          />
        </div>
        <label
          htmlFor={watchSwitchId}
          className="flex cursor-pointer items-center justify-between gap-3 border-t border-border/60 px-3 py-2 text-xs"
        >
          <span className="min-w-0">
            <span className="block font-medium text-muted-foreground">Watch</span>
            <span className="block text-muted-foreground/70">
              Send new annotations automatically
            </span>
          </span>
          <Switch
            id={watchSwitchId}
            size="sm"
            checked={watching}
            onCheckedChange={(checked) =>
              setWatching(threadKey, checked ? endpoint.annotationsUrl : null)
            }
          />
        </label>
      </PopoverPopup>
    </Popover>
  );
}

function QueueStateLabel({ state }: { state: AnnotationQueueState }) {
  switch (state) {
    case "done":
      return (
        <span className="flex items-center gap-1 text-success-foreground">
          <CheckIcon aria-hidden className="size-3.5" />
          Done
        </span>
      );
    case "working":
      return (
        <span className="flex items-center gap-1 text-info-foreground">
          <Spinner size="xs" />
          Working
        </span>
      );
    case "question":
      return (
        <span className="flex items-center gap-1 text-warning-foreground">
          <MessageCircleQuestionIcon aria-hidden className="size-3.5" />
          Question
        </span>
      );
    default:
      return (
        <span className="flex items-center gap-1 text-muted-foreground">
          <CircleIcon aria-hidden className="size-3 text-muted-foreground/40" />
          Waiting
        </span>
      );
  }
}
