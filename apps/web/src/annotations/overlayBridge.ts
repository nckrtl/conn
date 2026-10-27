// The renderer side of the annotation overlay in desktop browser tabs. The guest preload
// (apps/desktop/src/preview/ConnAnnotationsPreload.ts) sends each `window.__CONN_ANNOTATIONS__`
// call with `ipcRenderer.sendToHost`; this answers it from the Conn server with `webview.send`.
import { runAtomCommand, squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import type { AnnotationRecord, EnvironmentId, ProjectId } from "@t3tools/contracts";
import {
  ANNOTATION_BRIDGE_CHANNEL,
  annotationBelongsToOrigin,
  annotationOverlayConfigureScript,
  annotationOverlaySetModeScript,
  isAnnotationBridgeRequest,
  type AnnotationBridgeMessage,
  type AnnotationBridgeRequest,
} from "@t3tools/shared/annotationBridge";
import * as Option from "effect/Option";
import { AsyncResult } from "effect/reactivity";

import { appAtomRegistry } from "../rpc/atomRegistry";
import { previewEnvironment } from "../state/preview";

const FIRST_LIST_TIMEOUT_MS = 10_000;

interface GuestWebview extends Element {
  readonly executeJavaScript: (code: string, userGesture?: boolean) => Promise<unknown>;
  readonly send: (channel: string, ...args: ReadonlyArray<unknown>) => void;
  readonly getURL: () => string;
}

function errorMessage(error: unknown, fallback: string): string {
  return error instanceof Error && error.message ? error.message : fallback;
}

/** Answers the overlay's annotation calls in `webview` from the project's annotations; returns a stop function. */
export function attachOverlayBridge(input: {
  readonly webview: Element;
  readonly environmentId: EnvironmentId;
  readonly projectId: ProjectId;
}): () => void {
  const webview = input.webview as GuestWebview;
  const target = { environmentId: input.environmentId, input: { projectId: input.projectId } };
  let latest: ReadonlyArray<AnnotationRecord> | null = null;
  let failure: string | null = null;
  let firstSettled: () => void = () => {};
  const firstList = new Promise<void>((resolve) => {
    firstSettled = resolve;
  });

  const send = (message: AnnotationBridgeMessage) => {
    try {
      webview.send(ANNOTATION_BRIDGE_CHANNEL, message);
    } catch {
      // The guest is gone or not ready; it reads the list again when it asks.
    }
  };
  const pageOrigin = () => {
    try {
      return new URL(webview.getURL()).origin;
    } catch {
      return null;
    }
  };
  const visible = () => {
    const origin = pageOrigin();
    return origin === null
      ? []
      : (latest ?? []).filter((record) => annotationBelongsToOrigin(record, origin));
  };

  const stopLive = appAtomRegistry.subscribe(
    previewEnvironment.annotationsLive(target),
    (result) => {
      if (AsyncResult.isFailure(result)) {
        failure = errorMessage(squashAtomCommandFailure(result), "Annotations are unavailable.");
        firstSettled();
        return;
      }
      const value = Option.getOrNull(AsyncResult.value(result));
      if (value === null) return;
      latest = value.annotations;
      failure = null;
      firstSettled();
      send({ type: "changed" });
    },
    { immediate: true },
  );

  const list = async () => {
    if (latest === null && failure === null) {
      await Promise.race([
        firstList,
        new Promise((resolve) => setTimeout(resolve, FIRST_LIST_TIMEOUT_MS)),
      ]);
    }
    if (latest === null) throw new Error(failure ?? "Annotations are unavailable.");
    return visible();
  };

  const answer = async (request: AnnotationBridgeRequest) => {
    switch (request.op) {
      case "list":
        return list();
      case "submit": {
        const result = await runAtomCommand(
          appAtomRegistry,
          previewEnvironment.createAnnotation,
          {
            environmentId: input.environmentId,
            input: { projectId: input.projectId, annotation: request.payload },
          },
          { reportFailure: false },
        );
        if (result._tag === "Failure")
          throw new Error(errorMessage(squashAtomCommandFailure(result), "Could not save."));
        return result.value.annotation;
      }
      case "remove": {
        const allowed = new Set(visible().map((record) => record.id));
        const ids = request.payload.ids.filter((id) => allowed.has(id));
        if (ids.length === 0) return null;
        const result = await runAtomCommand(
          appAtomRegistry,
          previewEnvironment.removeAnnotations,
          { environmentId: input.environmentId, input: { projectId: input.projectId, ids } },
          { reportFailure: false },
        );
        if (result._tag === "Failure")
          throw new Error(errorMessage(squashAtomCommandFailure(result), "Could not remove."));
        return null;
      }
    }
  };

  const onMessage = (event: Event) => {
    const { channel, args } = event as Event & { channel?: string; args?: ReadonlyArray<unknown> };
    if (channel !== ANNOTATION_BRIDGE_CHANNEL) return;
    const request = args?.[0];
    if (!isAnnotationBridgeRequest(request)) return;
    void answer(request).then(
      (value) => send({ type: "reply", requestId: request.requestId, ok: true, value }),
      (error: unknown) =>
        send({
          type: "reply",
          requestId: request.requestId,
          ok: false,
          error: errorMessage(error, "Annotations are unavailable."),
        }),
    );
  };

  webview.addEventListener("ipc-message", onMessage);
  return () => {
    webview.removeEventListener("ipc-message", onMessage);
    stopLive();
  };
}

/** Loads the overlay into the webview's page, or reconfigures the one already there. */
export async function injectOverlay(
  webview: Element,
  options: Record<string, unknown> = {},
): Promise<void> {
  const guest = webview as GuestWebview;
  if ((await guest.executeJavaScript(annotationOverlayConfigureScript(options))) === true) return;
  const { default: bundle } = await import("@t3tools/annotation-overlay/inject?raw");
  await guest.executeJavaScript(bundle);
}

/** Turns annotation mode on or off; resolves to the new state, or null without an overlay. */
export async function setOverlayMode(webview: Element, active: boolean): Promise<boolean | null> {
  const state = await (webview as GuestWebview).executeJavaScript(
    annotationOverlaySetModeScript(active),
  );
  return typeof state === "boolean" ? state : null;
}
