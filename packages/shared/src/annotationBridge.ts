// The Conn annotation overlay (packages/annotation-overlay) runs in a browser tab's page and
// reads and writes annotations through `window.__CONN_ANNOTATIONS__`. Desktop tabs provide it
// in the guest preload and relay each call to the renderer over this channel; server tabs
// provide it with a Playwright binding.
import type { AnnotationCapture, AnnotationRecord } from "@t3tools/contracts";

/** IPC channel between a desktop tab's guest preload and the renderer that hosts it. */
export const ANNOTATION_BRIDGE_CHANNEL = "conn:annotations";

export const CONN_ANNOTATIONS_GLOBAL = "__CONN_ANNOTATIONS__";
export const ANNOTATION_OVERLAY_GLOBAL = "ConnAnnotationOverlay";
export const ANNOTATION_OVERLAY_OPTIONS_GLOBAL = "__CONN_ANNOTATION_OPTIONS__";

export type AnnotationBridgeOperation =
  | { readonly op: "list" }
  | { readonly op: "submit"; readonly payload: AnnotationCapture }
  | { readonly op: "remove"; readonly payload: { readonly ids: ReadonlyArray<string> } };

/** Guest to renderer: one call of `window.__CONN_ANNOTATIONS__`. */
export type AnnotationBridgeRequest = AnnotationBridgeOperation & { readonly requestId: string };

/** Renderer to guest: the answer to one request, or a note that the annotations changed. */
export type AnnotationBridgeMessage =
  | {
      readonly type: "reply";
      readonly requestId: string;
      readonly ok: true;
      readonly value: ReadonlyArray<AnnotationRecord> | AnnotationRecord | null;
    }
  | {
      readonly type: "reply";
      readonly requestId: string;
      readonly ok: false;
      readonly error: string;
    }
  | { readonly type: "changed" };

export function isAnnotationBridgeRequest(value: unknown): value is AnnotationBridgeRequest {
  if (typeof value !== "object" || value === null) return false;
  const message = value as Record<string, unknown>;
  if (typeof message.requestId !== "string") return false;
  switch (message.op) {
    case "list":
      return true;
    case "submit":
      return typeof message.payload === "object" && message.payload !== null;
    case "remove": {
      const ids = (message.payload as { ids?: unknown } | undefined)?.ids;
      return Array.isArray(ids) && ids.every((id) => typeof id === "string");
    }
    default:
      return false;
  }
}

export function isAnnotationBridgeMessage(value: unknown): value is AnnotationBridgeMessage {
  if (typeof value !== "object" || value === null) return false;
  const message = value as Record<string, unknown>;
  return (
    message.type === "changed" ||
    (message.type === "reply" && typeof message.requestId === "string")
  );
}

/** Only browser annotations of the page's own site reach the page. */
export function annotationBelongsToOrigin(
  record: Pick<AnnotationRecord, "source" | "url">,
  origin: string,
): boolean {
  if (record.source === "device" || !record.url) return false;
  try {
    return new URL(record.url).origin === origin;
  } catch {
    return false;
  }
}

/**
 * Page script: reconfigures a running overlay and returns true, or returns false when the
 * bundle still has to run. The bundle reads the options from the same global.
 */
export function annotationOverlayConfigureScript(options: Record<string, unknown>): string {
  return `(() => {
  const options = ${JSON.stringify(options)};
  window.${ANNOTATION_OVERLAY_OPTIONS_GLOBAL} = options;
  const overlay = window.${ANNOTATION_OVERLAY_GLOBAL};
  if (!overlay) return false;
  overlay.mount(options);
  return true;
})()`;
}

/** Page script: turns annotation mode on or off; returns the new state, or null without an overlay. */
export function annotationOverlaySetModeScript(active: boolean): string {
  return `(() => {
  const overlay = window.${ANNOTATION_OVERLAY_GLOBAL};
  return overlay ? overlay.setMode(${active}) : null;
})()`;
}

export const ANNOTATIONS_BINDING = "__connAnnotationsCall";
export const ANNOTATIONS_CHANGED_HOOK = "__connAnnotationsChanged";

/**
 * Page script for server tabs: defines `window.__CONN_ANNOTATIONS__` on top of the page
 * binding `__connAnnotationsCall(op, payload)`, replacing a desktop preload's copy. The server
 * calls `__connAnnotationsChanged()` when the stored annotations change.
 */
export const CONN_ANNOTATIONS_BINDING_SCRIPT = `(() => {
  if (window.${CONN_ANNOTATIONS_GLOBAL}?.server === true) return;
  const listeners = new Set();
  window.${ANNOTATIONS_CHANGED_HOOK} = () => listeners.forEach((listener) => { try { listener(); } catch {} });
  const call = (op, payload) => window.${ANNOTATIONS_BINDING}(op, payload);
  Object.defineProperty(window, "${CONN_ANNOTATIONS_GLOBAL}", {
    configurable: true,
    value: Object.freeze({
      server: true,
      list: () => call("list"),
      submit: (capture) => call("submit", capture),
      remove: (ids) => call("remove", { ids: [...ids] }).then(() => undefined),
      subscribe: (onChange) => { listeners.add(onChange); return () => listeners.delete(onChange); },
    }),
  });
})()`;
