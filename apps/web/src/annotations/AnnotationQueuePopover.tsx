import { scopedThreadKey } from "@t3tools/client-runtime/environment";
import type { AnnotationRecord, ScopedThreadRef } from "@t3tools/contracts";
import { Popover as PopoverPrimitive } from "@base-ui/react/popover";
import {
  BrushCleaningIcon,
  CheckIcon,
  CircleIcon,
  MessageCircleQuestionIcon,
  MessageSquareTextIcon,
  SendIcon,
  Trash2Icon,
} from "lucide-react";
import { useId, useState } from "react";

import { Badge } from "~/components/ui/badge";
import { Button } from "~/components/ui/button";
import { Kbd } from "~/components/ui/kbd";
import { Popover, PopoverTrigger } from "~/components/ui/popover";
import { Spinner } from "~/components/ui/spinner";
import { Switch } from "~/components/ui/switch";
import { Tooltip, TooltipPopup, TooltipTrigger } from "~/components/ui/tooltip";
import { cn } from "~/lib/utils";
import { previewEnvironment } from "~/state/preview";
import { useAtomCommand } from "~/state/use-atom-command";

import { type AnnotationQueueState, annotationState, countAnnotations } from "./annotationQueue";
import { useAnnotationWatch, useAnnotationWatchStore } from "./annotationWatchStore";
import { sendAnnotationPrompt } from "./sendAnnotationPrompt";
import type { AnnotationTarget } from "./useAnnotationQueue";

// Floating glass surface shared with the app's popovers and menus.
const PANEL_CLASS_NAME =
  "dropdown-glass w-96 max-w-(--available-width) origin-(--transform-origin) rounded-xl text-foreground shadow-lg outline-none transition-[scale,opacity] data-starting-style:scale-98 data-starting-style:opacity-0 data-ending-style:opacity-0";

/**
 * The annotation toolbar button and its hover queue. A click toggles annotation mode;
 * hover shows the queue with Send, Watch, Clear done and Remove idle.
 */
export function AnnotationQueuePopover(props: {
  readonly threadRef: ScopedThreadRef;
  /** The project queue; null until the thread's project is known. */
  readonly target: AnnotationTarget | null;
  readonly annotations: ReadonlyArray<AnnotationRecord> | null;
  readonly error: string | null;
  readonly annotating: boolean;
  readonly onToggle: () => void;
  readonly disabled?: boolean;
  /** What a click annotates. */
  readonly subject: "page" | "device";
  readonly side: "bottom" | "left";
  readonly size: "icon-xs" | "icon-sm";
}) {
  const { target } = props;
  const threadKey = scopedThreadKey(props.threadRef);
  const watch = useAnnotationWatch(threadKey);
  const setWatching = useAnnotationWatchStore((state) => state.setWatching);
  const removeAnnotations = useAtomCommand(previewEnvironment.removeAnnotations);
  const watchSwitchId = useId();
  const [confirmingRemove, setConfirmingRemove] = useState(false);
  const queue = props.annotations ?? [];
  const counts = countAnnotations(queue);
  const idle = queue.filter((annotation) => annotation.status !== "in_progress");
  const done = queue.filter((annotation) => annotation.status === "done");
  const watching =
    target !== null &&
    watch?.environmentId === target.environmentId &&
    watch.projectId === target.projectId;
  const remove = (records: ReadonlyArray<AnnotationRecord>) => {
    if (target === null || records.length === 0) return;
    void removeAnnotations({
      environmentId: target.environmentId,
      input: { projectId: target.projectId, ids: records.map((record) => record.id) },
    });
  };
  const action = props.annotating ? "Stop annotating" : `Annotate ${props.subject}`;

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
            variant={props.annotating ? "secondary" : "ghost"}
            size={props.size}
            aria-label={`${action}, ${counts.waiting} waiting`}
            aria-pressed={props.annotating ? "true" : "false"}
            type="button"
            className="relative"
            onClick={props.onToggle}
            disabled={props.disabled === true}
          />
        }
      >
        <MessageSquareTextIcon className={cn(props.annotating && "text-primary")} />
        {counts.waiting > 0 ? (
          <span aria-hidden className="pointer-events-none absolute -top-1.5 -right-1.5">
            <Badge size="sm">{counts.waiting}</Badge>
          </span>
        ) : null}
      </PopoverTrigger>
      <PopoverPrimitive.Portal>
        <PopoverPrimitive.Positioner
          align="end"
          side={props.side}
          sideOffset={6}
          className="z-[130]"
        >
          <PopoverPrimitive.Popup className={PANEL_CLASS_NAME}>
            <div className="flex items-start justify-between gap-3 px-3 pt-3 pb-2">
              <div className="min-w-0">
                <div className="text-ui font-medium">Annotations</div>
                <div className="truncate text-ui text-muted-foreground">
                  {props.annotating ? "click to stop annotating" : "click to annotate"}{" "}
                  <Kbd>⌘⇧A</Kbd>
                </div>
              </div>
              <div className="flex shrink-0 items-center gap-1">
                {watching ? (
                  <Badge variant="success" size="sm">
                    Watching
                  </Badge>
                ) : null}
                {done.length > 0 ? (
                  <Tooltip>
                    <TooltipTrigger
                      render={
                        <Button
                          variant="ghost"
                          size="icon-xs"
                          aria-label={`Clear ${done.length} done`}
                          type="button"
                          onClick={() => remove(done)}
                        />
                      }
                    >
                      <BrushCleaningIcon />
                    </TooltipTrigger>
                    <TooltipPopup>{`Clear ${done.length} done`}</TooltipPopup>
                  </Tooltip>
                ) : null}
                {idle.length > 0 ? (
                  <Tooltip>
                    <TooltipTrigger
                      render={
                        <Button
                          variant="ghost"
                          size="icon-xs"
                          aria-label={`Remove ${idle.length} not in progress`}
                          type="button"
                          onClick={() => setConfirmingRemove(true)}
                        />
                      }
                    >
                      <Trash2Icon />
                    </TooltipTrigger>
                    <TooltipPopup>{`Remove ${idle.length} not in progress`}</TooltipPopup>
                  </Tooltip>
                ) : null}
              </div>
            </div>
            {confirmingRemove && idle.length > 0 ? (
              <div className="flex items-center justify-between gap-3 border-t border-(--glass-divider)! px-3 py-2 text-ui">
                <span className="text-muted-foreground">
                  {`Remove ${idle.length} ${idle.length === 1 ? "annotation" : "annotations"} for everyone? Work in progress stays.`}
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
                      remove(idle);
                    }}
                  >
                    Remove
                  </Button>
                </span>
              </div>
            ) : null}
            {props.error !== null ? (
              <p
                role="alert"
                className="border-t border-(--glass-divider)! px-3 py-3 text-ui text-destructive"
              >
                {props.error}
              </p>
            ) : props.annotations === null ? (
              <p className="border-t border-(--glass-divider)! px-3 py-3 text-ui text-muted-foreground">
                Loading annotations…
              </p>
            ) : queue.length === 0 ? (
              <p className="border-t border-(--glass-divider)! px-3 py-3 text-ui text-muted-foreground">
                {`No annotations yet. Click the button, then click an element on the ${props.subject === "page" ? "page" : "screen"}.`}
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
                          {props.subject === "page" && annotation.source === "device"
                            ? " · device"
                            : ""}
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
            {watching ? (
              <p className="border-t border-(--glass-divider)! px-3 py-2.5 text-ui text-muted-foreground">
                New annotations go to this thread when it is idle.
                {counts.question > 0 ? " Questions wait for your answer in the thread." : ""}
              </p>
            ) : counts.waiting > 0 ? (
              <div className="border-t border-(--glass-divider)! px-3 py-2.5">
                <Button
                  size="xs"
                  className="w-full justify-center"
                  onClick={() =>
                    sendAnnotationPrompt({ threadRef: props.threadRef, annotations: queue })
                  }
                >
                  <SendIcon />
                  {`Send ${counts.waiting} to this thread`}
                </Button>
              </div>
            ) : null}
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
                disabled={target === null}
                onCheckedChange={(checked) => setWatching(threadKey, checked ? target : null)}
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
