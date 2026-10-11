import { scopedThreadKey } from "@t3tools/client-runtime/environment";
import type { ScopedThreadRef } from "@t3tools/contracts";
import {
  BrushCleaningIcon,
  CheckIcon,
  CircleIcon,
  MessageCircleQuestionIcon,
  MessageSquareTextIcon,
  SendIcon,
} from "lucide-react";
import { useId } from "react";

import {
  type AnnotationQueueState,
  type AnnotatorRecord,
  annotationState,
  clearDoneAnnotations,
  countAnnotations,
  openAnnotationCount,
} from "~/annotations/annotatorQueue";
import { useAnnotationWatch, useAnnotationWatchStore } from "~/annotations/annotationWatchStore";
import { sendAnnotationPrompt } from "~/annotations/sendAnnotationPrompt";
import { Badge } from "~/components/ui/badge";
import { Button } from "~/components/ui/button";
import { Kbd } from "~/components/ui/kbd";
import { Popover, PopoverPopup, PopoverTrigger } from "~/components/ui/popover";
import { Spinner } from "~/components/ui/spinner";
import { Switch } from "~/components/ui/switch";
import { Tooltip, TooltipPopup, TooltipTrigger } from "~/components/ui/tooltip";
import { cn } from "~/lib/utils";

export function DeviceAnnotationControl(props: {
  readonly threadRef: ScopedThreadRef;
  readonly hostId: string;
  readonly deviceId: string;
  readonly annotating: boolean;
  readonly onToggle: () => void;
  readonly annotationsUrl: string | null;
  readonly annotations: ReadonlyArray<AnnotatorRecord> | null;
  readonly error: string | null;
  /** True while `device.annotator` is starting. */
  readonly starting: boolean;
  /** The annotations URL did not answer. Distinct from a queue that has not loaded. */
  readonly unreachable: boolean;
}) {
  const threadKey = scopedThreadKey(props.threadRef);
  const watch = useAnnotationWatch(threadKey);
  const setWatching = useAnnotationWatchStore((state) => state.setWatching);
  const watchSwitchId = useId();
  const annotations = props.annotations ?? [];
  const counts = countAnnotations(annotations);
  const open = openAnnotationCount(counts);
  const watching =
    props.annotationsUrl !== null &&
    watch?.device?.hostId === props.hostId &&
    watch.device.deviceId === props.deviceId &&
    watch.annotationsUrl === props.annotationsUrl;
  const ready = props.annotationsUrl !== null && props.error === null;

  return (
    <Popover
      onOpenChange={(_open, details) => {
        if (details.reason === "trigger-press") details.cancel();
      }}
    >
      <PopoverTrigger
        openOnHover
        delay={150}
        closeDelay={150}
        render={
          <Button
            variant={props.annotating ? "secondary" : "ghost"}
            size="icon-sm"
            aria-label={`${props.annotating ? "Stop annotating" : "Annotate device"}, ${open} open`}
            aria-pressed={props.annotating ? "true" : "false"}
            type="button"
            onClick={() => {
              props.onToggle();
            }}
          />
        }
      >
        <MessageSquareTextIcon className={cn(props.annotating && "text-primary")} />
        {open > 0 ? (
          <span
            aria-hidden
            className="absolute -top-1 -right-1 flex h-3.5 min-w-3.5 items-center justify-center rounded-full bg-info px-1 text-3xs font-semibold tabular-nums text-white"
          >
            {open}
          </span>
        ) : null}
      </PopoverTrigger>
      <PopoverPopup side="left" align="end" sideOffset={6} width="lg" padding="none">
        <div className="flex items-start justify-between gap-3 px-3 pt-3 pb-2">
          <div className="min-w-0">
            <div className="text-sm font-medium">Annotations</div>
            <div className="truncate text-xs text-muted-foreground">
              {props.annotating ? "click to stop annotating" : "click to annotate"} <Kbd>⌘⇧A</Kbd>
            </div>
          </div>
          <div className="flex shrink-0 items-center gap-1">
            {watching ? (
              <Badge variant="success" size="sm">
                Watching
              </Badge>
            ) : null}
            {props.annotationsUrl !== null && counts.done > 0 ? (
              <Tooltip>
                <TooltipTrigger
                  render={
                    <Button
                      variant="ghost"
                      size="icon-xs"
                      aria-label={`Clear ${counts.done} done`}
                      type="button"
                      onClick={() => void clearDoneAnnotations(props.annotationsUrl!, annotations)}
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
        {props.error ? (
          <p role="alert" className="border-t border-border/60 px-3 py-3 text-xs text-destructive">
            {props.error}
          </p>
        ) : props.unreachable ? (
          <p role="alert" className="border-t border-border/60 px-3 py-3 text-xs text-destructive">
            The annotation server did not answer.
          </p>
        ) : null}
        {props.annotations === null && !props.error && !props.unreachable ? (
          <p className="border-t border-border/60 px-3 py-3 text-xs text-muted-foreground">
            {props.starting
              ? "Starting the annotation server…"
              : props.annotationsUrl
                ? "Loading annotations…"
                : "No annotations yet. Click the button, then click an element on the screen."}
          </p>
        ) : null}
        {props.annotations !== null && annotations.length === 0 ? (
          <p className="border-t border-border/60 px-3 py-3 text-xs text-muted-foreground">
            No annotations yet. Click the button, then click an element on the screen.
          </p>
        ) : null}
        {props.annotations !== null && annotations.length > 0 ? (
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
                    </div>
                  </div>
                  <span className="mt-0.5 text-xs">
                    <QueueStateLabel state={state} />
                  </span>
                </li>
              );
            })}
          </ol>
        ) : null}
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
              disabled={!ready || counts.waiting === 0}
              onClick={() => {
                if (props.annotationsUrl === null) return;
                sendAnnotationPrompt({
                  threadRef: props.threadRef,
                  annotationsUrl: props.annotationsUrl,
                  annotations,
                });
              }}
            >
              <SendIcon />
              {counts.waiting === 0 ? "Nothing waiting" : `Send ${counts.waiting} to this thread`}
            </Button>
          )}
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
            disabled={props.annotationsUrl === null}
            onCheckedChange={(checked) => {
              if (!checked || props.annotationsUrl === null) {
                setWatching(threadKey, null);
                return;
              }
              setWatching(threadKey, props.annotationsUrl, {
                hostId: props.hostId,
                deviceId: props.deviceId,
              });
            }}
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
