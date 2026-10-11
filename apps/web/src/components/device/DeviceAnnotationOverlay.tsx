import { useEffect, useRef, useState, type PointerEvent } from "react";

import { annotationState, type AnnotatorRecord } from "~/annotations/annotatorQueue";
import { cn } from "~/lib/utils";
import { Input } from "~/components/ui/input";

import {
  buildDeviceAnnotationPayload,
  deviceAnnotationRect,
  hitTestAxElement,
} from "./deviceAnnotations";
import type { DeviceAxElement } from "./deviceHubApi";

const rectStyle = (rect: { x: number; y: number; width: number; height: number }) => ({
  left: `${rect.x * 100}%`,
  top: `${rect.y * 100}%`,
  width: `${rect.width * 100}%`,
  height: `${rect.height * 100}%`,
});

const pinTone = (annotation: AnnotatorRecord) => {
  switch (annotationState(annotation)) {
    case "done":
      return {
        frame: "border border-muted-foreground/40",
        badge: "bg-muted text-muted-foreground",
      };
    case "question":
      return { frame: "border border-warning bg-warning/15", badge: "bg-warning text-white" };
    case "working":
      return { frame: "border-2 border-info bg-info/20", badge: "bg-info text-white" };
    default:
      return { frame: "border border-info/80 bg-info/10", badge: "bg-info text-white" };
  }
};

/** Hit-testing uses the flat frame, the same normalized space as the accessibility rects. */
export function DeviceAnnotationOverlay(props: {
  readonly active: boolean;
  readonly elements: ReadonlyArray<DeviceAxElement>;
  readonly annotations: ReadonlyArray<AnnotatorRecord>;
  readonly annotationsUrl: string | null;
  readonly hostId: string;
  readonly deviceId: string;
}) {
  const [hover, setHover] = useState<DeviceAxElement | null>(null);
  const [draft, setDraft] = useState<{ element: DeviceAxElement; text: string } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const point = useRef<{ x: number; y: number } | null>(null);
  const saveAbort = useRef<AbortController | null>(null);
  const [sessionActive, setSessionActive] = useState(props.active);
  if (props.active !== sessionActive) {
    setSessionActive(props.active);
    if (!props.active) {
      setHover(null);
      setDraft(null);
      setError(null);
      setSaving(false);
    }
  }

  useEffect(() => {
    if (!props.active) {
      saveAbort.current?.abort();
      point.current = null;
    }
  }, [props.active]);

  useEffect(() => {
    const last = point.current;
    if (!props.active || !last || draft) return;
    setHover(hitTestAxElement(props.elements, last.x, last.y));
  }, [draft, props.active, props.elements]);

  const pins = props.annotations.flatMap((annotation) => {
    const rect = deviceAnnotationRect(annotation);
    return rect ? [{ annotation, rect }] : [];
  });
  if (!props.active && pins.length === 0) return null;

  const highlight = draft?.element ?? hover;
  const normalizedPoint = (event: PointerEvent<HTMLElement>) => {
    const bounds = event.currentTarget.getBoundingClientRect();
    const x = (event.clientX - bounds.left) / bounds.width;
    const y = (event.clientY - bounds.top) / bounds.height;
    return { x: Math.min(1, Math.max(0, x)), y: Math.min(1, Math.max(0, y)) };
  };

  const submit = () => {
    if (!draft || saving) return;
    const payload = buildDeviceAnnotationPayload({
      comment: draft.text,
      element: draft.element,
      hostId: props.hostId,
      deviceId: props.deviceId,
    });
    if (!payload) {
      setDraft(null);
      setError(null);
      return;
    }
    if (props.annotationsUrl === null) {
      setError("Annotation server is unavailable.");
      return;
    }
    const controller = new AbortController();
    saveAbort.current?.abort();
    saveAbort.current = controller;
    setSaving(true);
    setError(null);
    void fetch(props.annotationsUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
      cache: "no-store",
      credentials: "omit",
      signal: controller.signal,
    })
      .then(async (response) => {
        if (controller.signal.aborted) return;
        if (response.ok) {
          setDraft(null);
          return;
        }
        const body = (await response.json().catch(() => null)) as { error?: unknown } | null;
        setError(
          typeof body?.error === "string"
            ? body.error
            : `Could not save the annotation (${response.status}).`,
        );
      })
      .catch(() => {
        if (controller.signal.aborted) return;
        setError("Could not reach the annotation server.");
      })
      .finally(() => {
        if (!controller.signal.aborted) setSaving(false);
      });
  };

  return (
    <div
      className={cn(
        "absolute inset-0 z-20",
        props.active ? "pointer-events-auto" : "pointer-events-none",
      )}
      onPointerDown={(event) => {
        if (!props.active) return;
        event.stopPropagation();
        if (event.target instanceof Element && event.target.closest("[data-annotation-comment]"))
          return;
        event.preventDefault();
        if (saving) return;
        event.currentTarget.closest<HTMLElement>('[role="application"]')?.focus();
        const next = normalizedPoint(event);
        point.current = next;
        const hit = hitTestAxElement(props.elements, next.x, next.y);
        setHover(hit);
        setError(null);
        setDraft(hit ? { element: hit, text: "" } : null);
      }}
      onPointerMove={(event) => {
        if (!props.active || draft) return;
        const next = normalizedPoint(event);
        point.current = next;
        setHover(hitTestAxElement(props.elements, next.x, next.y));
      }}
      onPointerLeave={() => {
        if (!draft) setHover(null);
      }}
    >
      {pins.map(({ annotation, rect }) => {
        const tone = pinTone(annotation);
        return (
          <div
            key={annotation.id}
            className={cn("pointer-events-none absolute", tone.frame)}
            style={rectStyle(rect)}
          >
            <span
              className={cn(
                "absolute -top-3.5 left-0 flex size-4.5 items-center justify-center rounded-full text-3xs font-semibold tabular-nums",
                tone.badge,
              )}
            >
              {annotation.number}
            </span>
          </div>
        );
      })}
      {props.active && highlight ? (
        <div
          className="pointer-events-none absolute border-2 border-primary bg-primary/10"
          style={rectStyle(highlight)}
        />
      ) : null}
      {props.active && draft ? (
        <form
          data-annotation-comment
          className="absolute z-10 w-44"
          style={{
            left: `${Math.min(Math.max(draft.element.x, 0), 0.55) * 100}%`,
            top: `${Math.min(draft.element.y + draft.element.height + 0.01, 0.88) * 100}%`,
          }}
          onSubmit={(event) => {
            event.preventDefault();
            submit();
          }}
        >
          <Input
            size="sm"
            autoFocus
            value={draft.text}
            disabled={saving}
            placeholder="Comment"
            aria-label="Annotation comment"
            onChange={(event) =>
              setDraft({ element: draft.element, text: event.currentTarget.value })
            }
            onKeyDown={(event) => {
              event.stopPropagation();
              if (event.key === "Escape") {
                event.preventDefault();
                setDraft(null);
                setError(null);
              }
            }}
          />
          <button type="submit" className="sr-only">
            Add annotation
          </button>
          {error ? <p className="mt-1 text-xs text-destructive">{error}</p> : null}
        </form>
      ) : null}
    </div>
  );
}
