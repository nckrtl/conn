import { pushAnnotation } from "../sync";
import { annotations } from "../state";
import { applyCreatedAnnotations } from "../actions";
import {
  onFinishActiveDraft,
  onOutsideAnnotationClick,
  stopAndWaitForPaste,
} from "../outside-click";
import { finishDraft, finishDraftAndMove, submitDraftAndMove } from "../actions";
import { stopsOnNextElement } from "../dictation";
import { usesHostSessions } from "../dictation-trigger";
import { ArrowUpIcon, Cog6ToothIcon, MicrophoneIcon, TrashIcon } from "../icons";
import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type KeyboardEvent,
  type ReactNode,
} from "react";
import AnnotationMetadata from "./AnnotationMetadata";
import {
  POPUP_CONTROL_SIZE,
  POPUP_HEIGHT,
  POPUP_WIDTH,
  percentToViewportX,
  popupPosition,
} from "../dom";
import { createRef, dictationSettings, useRefValue, viewportTick } from "../state";
import { useDictation } from "../useDictation";
import { Button } from "./ui/button";
import { cn } from "../lib/utils";
import type { AnnotationDraft } from "../types";

type AnnotationPopupProps = {
  draft: AnnotationDraft;
  shakeToken?: number;
  onSubmit: (comment: string) => void;
  onCancel: () => void;
  onDelete: () => void;
};

const controlClass =
  "inline-flex size-[var(--toolbar-control-size)] items-center justify-center rounded-full border-0 !text-[length:var(--toolbar-font-size)] leading-none shadow-none";
const solidControlClass = "bg-white text-[#111111] hover:bg-white/80 hover:text-[#111111]";
const iconClass = "size-[var(--toolbar-icon-size)]";

function IconButton({
  label,
  onClick,
  className,
  disabled = false,
  testId,
  expanded,
  children,
}: {
  label: string;
  onClick: () => void;
  className?: string;
  disabled?: boolean;
  testId?: string;
  expanded?: boolean;
  children: ReactNode;
}) {
  return (
    <Button
      type="button"
      variant="ghost"
      size="icon-sm"
      data-annotation-settings={testId === "settings" ? true : undefined}
      data-annotation-delete={testId === "delete" ? true : undefined}
      data-annotation-submit={testId === "submit" ? true : undefined}
      className={cn(controlClass, className)}
      aria-label={label}
      aria-expanded={expanded}
      disabled={disabled}
      onClick={onClick}
    >
      {children}
    </Button>
  );
}

export default function AnnotationPopup({
  draft,
  shakeToken = 0,
  onSubmit,
  onCancel,
  onDelete,
}: AnnotationPopupProps) {
  const savedAnnotation = useRefValue(annotations).find(
    (annotation) => annotation.id === draft.annotationId,
  );
  const [retrying, setRetrying] = useState(false);
  const [commentRef] = useState(() => createRef(draft.comment ?? ""));
  const comment = useRefValue(commentRef);
  const textarea = useRef<HTMLTextAreaElement | null>(null);
  const popup = useRef<HTMLDivElement | null>(null);
  const box = useRef<HTMLDivElement | null>(null);
  const [popupHeight, setPopupHeight] = useState(POPUP_HEIGHT);
  const [shaking, setShaking] = useState(false);
  const [fieldHeight, setFieldHeight] = useState(POPUP_CONTROL_SIZE);
  const [controlSize, setControlSize] = useState(POPUP_CONTROL_SIZE);
  const currentDraft = useRef(draft);
  currentDraft.current = draft;
  const pendingMove = useRef<AbortController | null>(null);
  const [moving, setMoving] = useState(false);
  const [detailsOpen, setDetailsOpen] = useState(false);
  const shakeTimer = useRef(0);
  const previousShake = useRef(shakeToken);
  useRefValue(viewportTick);
  const settings = useRefValue(dictationSettings);
  const isEditing = Boolean(draft.annotationId);

  const {
    enabled: dictationEnabled,
    hostSessions,
    state: dictationState,
    error: dictationError,
    elapsedMs,
    levels,
    toggle: toggleDictation,
    onEnter: onDictationEnter,
    onEscape: onDictationEscape,
    handOff: handOffDictation,
  } = useDictation({
    comment: commentRef,
    autoStart: !isEditing && settings.autoStart !== false,
    settings,
    sessionId: draft.draftId ?? "",
    onBeforeTrigger: () => textarea.current?.focus(),
    onSubmit: () => submit(),
    onFinish: () => finishRecording(),
  });

  const typedText = () => textarea.current?.value ?? commentRef.value;

  function finishRecording(): boolean {
    const session = handOffDictation();
    if (!session) return false;
    void finishDraft(currentDraft.current, typedText(), session);
    return true;
  }

  useEffect(() => {
    const unfinish = onFinishActiveDraft(() => void finishRecording());
    if (!stopsOnNextElement(settings)) return unfinish;
    const unsubscribe = onOutsideAnnotationClick((next) => {
      const field = textarea.current;
      if (!field || pendingMove.current || dictationState === "triggering") return;
      if (usesHostSessions(settings)) {
        const session = handOffDictation();
        if (session) void finishDraftAndMove(currentDraft.current, field.value, session, next);
        else submitDraftAndMove(field.value, currentDraft.current, next);
        return;
      }
      const controller = new AbortController();
      pendingMove.current = controller;
      setMoving(true);
      void stopAndWaitForPaste(field, settings, controller.signal)
        .then((text) => {
          if (controller.signal.aborted) return;
          commentRef.value = text;
          submitDraftAndMove(text, currentDraft.current, next);
        })
        // Stopping fails when nothing is recording; keep what the field holds instead.
        .catch(() => {
          if (!controller.signal.aborted)
            submitDraftAndMove(field.value, currentDraft.current, next);
        })
        .finally(() => {
          if (pendingMove.current === controller) {
            pendingMove.current = null;
            if (!controller.signal.aborted) setMoving(false);
          }
        });
    });
    return () => {
      unfinish();
      unsubscribe();
    };
  }, [settings, dictationState, draft]);

  useEffect(
    () => () => {
      pendingMove.current?.abort();
    },
    [],
  );

  const pad = 8;
  const stackGap = 10;
  const boxHeight = pad * 2 + fieldHeight + stackGap + controlSize;
  const fieldWidth = POPUP_WIDTH - pad * 2;
  const anchorX = percentToViewportX(draft.x);
  const anchorY = draft.isFixed ? draft.y : draft.y - window.scrollY;
  const position = popupPosition(anchorX, anchorY, {
    width: POPUP_WIDTH,
    height: Math.max(POPUP_HEIGHT, popupHeight),
  });
  const placeholder = moving ? "Waiting for paste…" : "Listening";
  const total = Math.floor(elapsedMs / 1000);
  const elapsedLabel = `${Math.floor(total / 60)}:${String(total % 60).padStart(2, "0")}`;
  // The dictation app records and shows it; the box only waits for its text.
  const hostRecording = hostSessions && dictationState === "recording";
  const canSubmit = Boolean(comment.trim()) || hostRecording;

  const readControlSize = () => {
    const node = box.current;

    if (!node) {
      return POPUP_CONTROL_SIZE;
    }

    const next = Number.parseFloat(
      getComputedStyle(node).getPropertyValue("--toolbar-control-size"),
    );

    return Number.isFinite(next) && next > 0 ? next : POPUP_CONTROL_SIZE;
  };

  const fitField = () => {
    const field = textarea.current;

    if (!field) {
      return;
    }

    const nextControl = readControlSize();
    setControlSize(nextControl);

    const styles = getComputedStyle(field);
    const lineHeight = Number.parseFloat(styles.lineHeight);
    const paddingTop = Number.parseFloat(styles.paddingTop);
    const minHeight =
      (Number.isFinite(lineHeight) ? lineHeight : nextControl) +
      (Number.isFinite(paddingTop) ? paddingTop * 2 : 0);
    setFieldHeight(Math.max(minHeight, field.scrollHeight || minHeight));
  };

  const focusField = () => {
    window.requestAnimationFrame(() => {
      const field = textarea.current;
      if (!field) return;
      field.focus();
      field.selectionStart = field.selectionEnd = field.value.length;
    });
  };

  function submit() {
    if (finishRecording()) return;
    const text = typedText().trim();

    if (pendingMove.current || !text) {
      return;
    }

    commentRef.value = text;
    onSubmit(text);
  }

  const onKeydown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    event.stopPropagation();

    if (event.nativeEvent.isComposing) {
      return;
    }

    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();

      if (pendingMove.current) return;
      if (onDictationEnter()) {
        return;
      }

      submit();
    }

    if (event.key === "Escape") {
      event.preventDefault();

      if (onDictationEscape()) {
        return;
      }

      onCancel();
    }
  };

  useEffect(() => {
    if (dictationState === "idle" && commentRef.value.trim()) {
      focusField();
    }
  }, [dictationState]);

  useEffect(() => {
    if (dictationState !== "recording") {
      focusField();
    }
  }, [dictationState]);

  useEffect(() => {
    if (previousShake.current === shakeToken) {
      return;
    }

    previousShake.current = shakeToken;
    window.clearTimeout(shakeTimer.current);
    setShaking(true);
    shakeTimer.current = window.setTimeout(() => {
      setShaking(false);
      if (dictationState === "idle") {
        focusField();
      }
    }, 250);
  }, [shakeToken, dictationState]);

  useEffect(() => {
    commentRef.value = draft.comment ?? "";
    if (!dictationEnabled || isEditing) {
      focusField();
    }
  }, [draft.annotationId]);

  useEffect(() => {
    if (!dictationEnabled || isEditing || settings.autoStart === false) {
      focusField();
    }

    return () => {
      window.clearTimeout(shakeTimer.current);
    };
  }, []);

  useLayoutEffect(() => {
    fitField();
    setPopupHeight(popup.current?.offsetHeight ?? POPUP_HEIGHT);
  }, [comment, placeholder, draft.annotationId, fieldHeight, controlSize, detailsOpen]);

  useEffect(() => {
    const field = textarea.current;

    if (!field) {
      return;
    }

    const syncValue = () => {
      commentRef.value = field.value;
      fitField();
    };

    const onNativeKeyDown = (event: globalThis.KeyboardEvent) => {
      event.stopPropagation();

      if (event.isComposing) {
        return;
      }

      if (event.key === "Enter" && !event.shiftKey) {
        event.preventDefault();

        if (pendingMove.current) return;
        if (onDictationEnter()) {
          return;
        }

        submit();
      }

      if (event.key === "Escape") {
        event.preventDefault();

        if (onDictationEscape()) {
          return;
        }

        onCancel();
      }
    };

    field.addEventListener("input", syncValue);
    field.addEventListener("keydown", onNativeKeyDown);

    return () => {
      field.removeEventListener("input", syncValue);
      field.removeEventListener("keydown", onNativeKeyDown);
    };
  }, [dictationState]);

  const settingsButton = (
    <IconButton
      label={detailsOpen ? "Hide annotation details" : "Show annotation details"}
      onClick={() => setDetailsOpen((open) => !open)}
      testId="settings"
      expanded={detailsOpen}
      className={cn(
        "bg-white/10 text-white/80 hover:bg-white/15 hover:text-white",
        detailsOpen && "bg-white/20 text-white",
      )}
    >
      <Cog6ToothIcon className={iconClass} />
    </IconButton>
  );

  const deleteButton = isEditing ? (
    <IconButton
      label="Delete annotation"
      onClick={onDelete}
      testId="delete"
      className="bg-transparent text-white/35 hover:bg-white/10 hover:text-danger"
    >
      <TrashIcon className={iconClass} />
    </IconButton>
  ) : null;

  const recorder =
    dictationEnabled && dictationState === "recording" ? (
      <Button
        type="button"
        variant="ghost"
        className={cn(
          controlClass,
          "h-[var(--toolbar-control-size)] w-auto gap-1.5 bg-white/10 px-2 text-white/85 hover:bg-white/15",
        )}
        aria-label="Stop dictation"
        onClick={toggleDictation}
        disabled={moving}
      >
        <span className="block size-2 rounded-[2px] bg-current" />
        <span className="leading-none tabular-nums">{elapsedLabel}</span>
        <span className="flex h-3 items-end gap-0.5 text-white/80" aria-hidden="true">
          {levels.map((level, index) => (
            <span
              key={index}
              className="w-0.5 rounded-full bg-current"
              style={{ height: `${4 + level * 8}px` }}
            />
          ))}
        </span>
      </Button>
    ) : dictationEnabled ? (
      <Button
        type="button"
        variant="ghost"
        size="icon-sm"
        className={cn(
          controlClass,
          solidControlClass,
          (dictationState === "transcribing" || dictationState === "triggering") &&
            "cursor-progress opacity-70",
        )}
        aria-label={
          dictationState === "triggering"
            ? "Starting dictation"
            : dictationState === "transcribing"
              ? "Transcribing"
              : "Dictate comment"
        }
        onClick={toggleDictation}
        disabled={moving}
      >
        {dictationState === "transcribing" || dictationState === "triggering" ? (
          <svg
            className={cn("toolbar-annotation-spin", iconClass)}
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.75"
          >
            <circle cx="12" cy="12" r="8" opacity="0.25" />
            <path d="M12 4a8 8 0 0 1 8 8" />
          </svg>
        ) : (
          <MicrophoneIcon className={iconClass} />
        )}
      </Button>
    ) : null;

  // Always visible, disabled until there is text (or a host recording to finish), so the action
  // never jumps into view.
  const sendButton =
    dictationState !== "recording" || hostRecording ? (
      <IconButton
        label={isEditing ? "Save annotation" : "Add annotation"}
        onClick={submit}
        testId="submit"
        disabled={!canSubmit || moving}
        className={cn("disabled:opacity-30", solidControlClass)}
      >
        <ArrowUpIcon className={iconClass} />
      </IconButton>
    ) : null;

  return (
    <div
      ref={popup}
      data-annotation-popup
      className={cn(
        "pointer-events-auto absolute w-72 text-white",
        shaking && "toolbar-annotation-shake",
      )}
      data-annotation-expanded="true"
      data-field-expanded
      style={{ left: `${position.left}px`, top: `${position.top}px` }}
      onClick={(event) => event.stopPropagation()}
      onMouseDown={(event) => event.stopPropagation()}
    >
      <div
        ref={box}
        data-annotation-box
        className="relative w-72 overflow-hidden rounded-xl border border-white/10 bg-[#111111]/95 shadow-none backdrop-blur-xl"
        style={{ height: boxHeight }}
      >
        <div
          data-annotation-actions
          className="pointer-events-none absolute right-2 bottom-2 left-2 z-20 flex h-[var(--toolbar-control-size)] items-center gap-1.5"
        >
          <div className="pointer-events-auto flex items-center gap-1.5">
            {settingsButton}
            {deleteButton}
          </div>
          <div className="pointer-events-auto ml-auto flex items-center gap-1.5">
            {hostRecording ? null : recorder}
            {sendButton}
          </div>
        </div>
        <textarea
          ref={textarea}
          data-annotation-field
          value={comment}
          onChange={(event) => {
            commentRef.value = (event.target as HTMLTextAreaElement).value;
            fitField();
          }}
          className="absolute z-10 m-0 resize-none overflow-hidden border-0 bg-transparent px-[5px] py-0 leading-[var(--toolbar-annotation-line-height)] text-white outline-none placeholder:text-white/35"
          style={{
            left: pad,
            top: pad,
            width: fieldWidth,
            height: fieldHeight,
          }}
          placeholder={placeholder}
          rows={1}
          onKeyDown={onKeydown}
        />
      </div>
      {savedAnnotation?.syncError ? (
        <div role="alert" className="px-4 py-2 text-xs text-red-300">
          {savedAnnotation.syncError}
          <button
            type="button"
            disabled={retrying}
            className="ml-2 underline"
            onClick={() => {
              setRetrying(true);
              void pushAnnotation(savedAnnotation)
                .then((updated) => {
                  if (updated) applyCreatedAnnotations([updated]);
                })
                .finally(() => setRetrying(false));
            }}
          >
            {retrying ? "Retrying…" : "Retry"}
          </button>
        </div>
      ) : null}
      {dictationError ? (
        <div
          role="alert"
          className="mt-2 rounded-xl border border-white/10 bg-[#111111]/95 px-2 py-2 text-xs text-white"
        >
          {dictationError}
        </div>
      ) : null}
      {detailsOpen ? <AnnotationMetadata draft={draft} /> : null}
    </div>
  );
}
