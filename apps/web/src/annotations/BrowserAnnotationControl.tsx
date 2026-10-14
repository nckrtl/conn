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
  Trash2Icon,
} from "lucide-react";
import { useCallback, useEffect, useEffectEvent, useId, useMemo, useState } from "react";

import { Badge } from "~/components/ui/badge";
import { Button } from "~/components/ui/button";
import { DraftInput } from "~/components/ui/draft-input";
import { Kbd } from "~/components/ui/kbd";
import { Popover as PopoverPrimitive } from "@base-ui/react/popover";
import { Popover, PopoverTrigger } from "~/components/ui/popover";
import { Spinner } from "~/components/ui/spinner";
import { Switch } from "~/components/ui/switch";
import { Tooltip, TooltipPopup, TooltipTrigger } from "~/components/ui/tooltip";
import { useClientSettings, useUpdatePrimarySettings } from "~/hooks/useSettings";
import { cn } from "~/lib/utils";
import { isPreviewFocused } from "~/lib/previewFocus";

import {
  type AnnotationDictation,
  type AnnotationQueueState,
  annotationState,
  annotatorEndpointForPage,
  clearDoneAnnotations,
  countAnnotations,
  removeIdleAnnotations,
  openAnnotationCount,
  overlayBootstrapScript,
  overlayConfigureScript,
  overlaySetModeScript,
} from "./annotatorQueue";
import { useAnnotationWatch, useAnnotationWatchStore } from "./annotationWatchStore";
import { sendAnnotationPrompt } from "./sendAnnotationPrompt";
import { useAnnotatorQueue } from "./useAnnotatorQueue";
import { handleBrowserAnnotationKey } from "./browserAnnotationKeyboard";

type PreviewWebview = HTMLElement & {
  executeJavaScript?: (code: string) => Promise<unknown>;
};

// Floating glass surface shared with the app's popovers and menus.
const PANEL_CLASS_NAME =
  "dropdown-glass w-96 max-w-(--available-width) origin-(--transform-origin) rounded-xl text-foreground shadow-lg outline-none transition-[scale,opacity] data-starting-style:scale-98 data-starting-style:opacity-0 data-ending-style:opacity-0";

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
  runServerAnnotation,
  inputDisabled = false,
}: {
  threadRef: ScopedThreadRef;
  runtimeTabId: string | null;
  pageUrl: string | null;
  loading: boolean;
  runServerAnnotation?: (active: boolean, dictation: AnnotationDictation) => boolean;
  inputDisabled?: boolean;
}) {
  const endpoint = useMemo(
    () => (pageUrl === null ? null : annotatorEndpointForPage(pageUrl)),
    [pageUrl],
  );
  const annotations = useAnnotatorQueue(endpoint);
  const available = annotations !== null;
  const threadKey = scopedThreadKey(threadRef);
  const watch = useAnnotationWatch(threadKey);
  const setWatching = useAnnotationWatchStore((state) => state.setWatching);
  const [annotating, setAnnotating] = useState(false);
  const watchSwitchId = useId();
  const [confirmingRemove, setConfirmingRemove] = useState(false);
  const dictationStartUrl = useClientSettings((settings) => settings.annotationDictationUrl);
  const dictationStopUrl = useClientSettings((settings) => settings.annotationDictationStopUrl);
  const updateSettings = useUpdatePrimarySettings();
  const dictation = useMemo(
    () => ({ startUrl: dictationStartUrl, stopUrl: dictationStopUrl }),
    [dictationStartUrl, dictationStopUrl],
  );

  const bootstrap = useEffectEvent((tabId: string, target: NonNullable<typeof endpoint>) =>
    runInPage(tabId, overlayBootstrapScript(target, dictation)),
  );
  const configureServerMode = useEffectEvent(() => {
    if (!inputDisabled) runServerAnnotation?.(annotating, dictation);
  });

  const applyMode = useCallback(
    (active: boolean) => {
      if (runtimeTabId === null || !available || inputDisabled) return;
      if (runServerAnnotation) {
        if (!runServerAnnotation(active, dictation)) return;
      } else {
        runInPage(runtimeTabId, overlaySetModeScript(active));
      }
      setAnnotating(active);
    },
    [runtimeTabId, available, inputDisabled, runServerAnnotation, dictation],
  );
  const resetMode = useEffectEvent(() => applyMode(false));

  useEffect(() => {
    const handleKey = (event: KeyboardEvent) =>
      handleBrowserAnnotationKey(
        event,
        { focused: isPreviewFocused(), active: annotating, disabled: inputDisabled || !available },
        applyMode,
      );
    window.addEventListener("keydown", handleKey, true);
    return () => window.removeEventListener("keydown", handleKey, true);
  }, [annotating, inputDisabled, available, applyMode]);

  // Navigation starts with annotation off. Never restore a stale toolbar state after
  // the page has handled Escape, or when a viewer takes control again.
  useEffect(() => {
    if (!available || loading || endpoint === null || runtimeTabId === null) return;
    if (runServerAnnotation) {
      resetMode();
      return;
    }
    bootstrap(runtimeTabId, endpoint);
    // The overlay mounts once its script has run; give it a moment.
    const timer = setTimeout(() => resetMode(), 400);
    return () => clearTimeout(timer);
  }, [available, endpoint, loading, runtimeTabId, inputDisabled, runServerAnnotation]);

  // Changed dictation settings apply to the running overlay without a reload.
  useEffect(() => {
    if (runServerAnnotation) configureServerMode();
  }, [dictation, runServerAnnotation]);
  useEffect(() => {
    if (!runServerAnnotation && runtimeTabId !== null)
      runInPage(runtimeTabId, overlayConfigureScript(dictation));
  }, [dictation, runtimeTabId, runServerAnnotation]);

  const toggleAnnotating = useCallback(() => {
    applyMode(!annotating);
  }, [annotating, applyMode]);

  // Stay in the toolbar even when this page has no annotator, so the control is
  // where it is in browser mode. The popover explains why annotation cannot start.
  if (endpoint === null || runtimeTabId === null) return null;

  const queue = annotations ?? [];
  const counts = countAnnotations(queue);
  const open = openAnnotationCount(counts);
  const idle = queue.length - counts.working;
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
            disabled={inputDisabled}
          />
        }
      >
        <MessageSquareTextIcon className={cn(annotating && "text-primary")} />
        {open > 0 ? (
          <span
            aria-hidden
            className="absolute -top-1 -right-1 flex h-3.5 min-w-3.5 items-center justify-center rounded-full bg-primary px-1 text-3xs font-semibold tabular-nums text-primary-foreground"
          >
            {open}
          </span>
        ) : null}
      </PopoverTrigger>
      <PopoverPrimitive.Portal>
        <PopoverPrimitive.Positioner align="end" side="bottom" sideOffset={6} className="z-[130]">
          <PopoverPrimitive.Popup className={PANEL_CLASS_NAME}>
            <div className="flex items-start justify-between gap-3 px-3 pt-3 pb-2">
              <div className="min-w-0">
                <div className="text-ui font-medium">Annotations</div>
                <div className="truncate text-ui text-muted-foreground">
                  {endpoint.origin} ·{" "}
                  {!available
                    ? "no annotator on this page"
                    : annotating
                      ? "click to stop annotating"
                      : "click to annotate"}{" "}
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
                          onClick={() => void clearDoneAnnotations(endpoint.annotationsUrl, queue)}
                        />
                      }
                    >
                      <BrushCleaningIcon />
                    </TooltipTrigger>
                    <TooltipPopup>{`Clear ${counts.done} done`}</TooltipPopup>
                  </Tooltip>
                ) : null}
                {idle > 0 ? (
                  <Tooltip>
                    <TooltipTrigger
                      render={
                        <Button
                          variant="ghost"
                          size="icon-xs"
                          aria-label={`Remove ${idle} not in progress`}
                          type="button"
                          onClick={() => setConfirmingRemove(true)}
                        />
                      }
                    >
                      <Trash2Icon />
                    </TooltipTrigger>
                    <TooltipPopup>{`Remove ${idle} not in progress`}</TooltipPopup>
                  </Tooltip>
                ) : null}
              </div>
            </div>
            {confirmingRemove && idle > 0 ? (
              <div className="flex items-center justify-between gap-3 border-t border-(--glass-divider)! px-3 py-2 text-ui">
                <span className="text-muted-foreground">
                  {`Remove ${idle} ${idle === 1 ? "annotation" : "annotations"} for everyone? Work in progress stays.`}
                </span>
                <span className="flex shrink-0 items-center gap-1">
                  <Button size="xs" variant="ghost" onClick={() => setConfirmingRemove(false)}>
                    Cancel
                  </Button>
                  <Button
                    size="xs"
                    variant="destructive"
                    onClick={() => {
                      setConfirmingRemove(false);
                      void removeIdleAnnotations(endpoint.annotationsUrl, queue);
                    }}
                  >
                    Remove
                  </Button>
                </span>
              </div>
            ) : null}
            {!available ? (
              <p className="border-t border-(--glass-divider)! px-3 py-3 text-ui text-muted-foreground">
                This page has no annotator. Open a page that serves one, then click an element.
              </p>
            ) : queue.length === 0 ? (
              <p className="border-t border-(--glass-divider)! px-3 py-3 text-ui text-muted-foreground">
                No annotations yet. Click the button, then click an element on the page.
              </p>
            ) : (
              <ol
                role="list"
                className="max-h-80 overflow-y-auto border-t border-(--glass-divider)! p-1.5 text-ui"
              >
                {queue.map((annotation) => {
                  const state = annotationState(annotation);
                  return (
                    <li
                      key={annotation.id}
                      className="grid grid-cols-[auto_minmax(0,1fr)_auto] items-start gap-x-2.5 rounded-lg px-1.5 py-1.5 hover:bg-accent"
                    >
                      <span
                        className={cn(
                          "mt-0.5 flex size-4.5 items-center justify-center rounded-full text-3xs font-semibold tabular-nums",
                          state === "done"
                            ? "bg-muted text-muted-foreground"
                            : "bg-primary text-primary-foreground",
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
                        <div className="mt-0.5 truncate text-ui text-muted-foreground">
                          {annotation.summary ?? annotation.element ?? annotation.pathname}
                          {annotation.source ? ` · ${annotation.source}` : ""}
                        </div>
                      </div>
                      <span className="mt-0.5 text-ui">
                        <QueueStateLabel state={state} />
                      </span>
                    </li>
                  );
                })}
              </ol>
            )}
            <div className="border-t border-(--glass-divider)! px-3 py-2.5">
              {watching ? (
                <p className="text-ui text-muted-foreground">
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
                      annotations: queue,
                    })
                  }
                >
                  <SendIcon />
                  {counts.waiting === 0
                    ? "Nothing waiting"
                    : `Send ${counts.waiting} to this thread`}
                </Button>
              )}
            </div>
            <div className="flex items-center gap-2 border-t border-(--glass-divider)! px-3 py-2 text-ui">
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
              className="flex cursor-pointer items-center justify-between gap-3 border-t border-(--glass-divider)! px-3 py-2 text-ui"
            >
              <span className="min-w-0">
                <span className="block font-medium text-muted-foreground">Watch</span>
                <span className="block text-muted-foreground">
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
          </PopoverPrimitive.Popup>
        </PopoverPrimitive.Positioner>
      </PopoverPrimitive.Portal>
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
