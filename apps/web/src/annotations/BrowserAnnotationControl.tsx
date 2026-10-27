import type { ScopedThreadRef } from "@t3tools/contracts";
import {
  annotationBelongsToOrigin,
  annotationOverlayConfigureScript,
} from "@t3tools/shared/annotationBridge";
import { useEffect, useEffectEvent, useState } from "react";

import { executeReadyWebviewScript, isWebviewDomReady } from "~/browser/webviewDomReady";
import { useClientSettings } from "~/hooks/useSettings";
import { isPreviewFocused } from "~/lib/previewFocus";
import { previewBridge } from "~/components/preview/previewBridge";

import { AnnotationQueuePopover } from "./AnnotationQueuePopover";
import { type AnnotationDictation, hostDictationUrls, overlayOptions } from "./annotationQueue";
import { handleBrowserAnnotationKey } from "./browserAnnotationKeyboard";
import { injectOverlay, setOverlayMode } from "./overlayBridge";
import { useAnnotationQueue, useThreadAnnotationTarget } from "./useAnnotationQueue";

type PreviewWebview = HTMLElement & {
  readonly isConnected: boolean;
  executeJavaScript(code: string): Promise<unknown>;
};

/** The element is replaced after a crash, so look it up on every call. */
function readyWebview(runtimeTabId: string): PreviewWebview | null {
  const webview = document.querySelector<PreviewWebview>(
    `webview[data-preview-tab="${CSS.escape(runtimeTabId)}"]`,
  );
  return webview !== null && isWebviewDomReady(webview) ? webview : null;
}

function pageOrigin(pageUrl: string | null): string | null {
  if (pageUrl === null) return null;
  try {
    const url = new URL(pageUrl);
    return url.protocol === "http:" || url.protocol === "https:" ? url.origin : null;
  } catch {
    return null;
  }
}

/**
 * Browser toolbar control for annotations. A click loads the overlay into the page and turns
 * annotation mode on; hover shows the project's queue. Desktop tabs run the overlay in the
 * webview; server tabs ask the server to run it (`runServerAnnotation`).
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
  const target = useThreadAnnotationTarget(threadRef);
  const { annotations, error } = useAnnotationQueue(target);
  const [annotating, setAnnotating] = useState(false);
  // A new document, tab or viewer starts with annotation off; never restore a stale state.
  const [modeScope, setModeScope] = useState({ runtimeTabId, loading, inputDisabled });
  if (
    modeScope.runtimeTabId !== runtimeTabId ||
    modeScope.loading !== loading ||
    modeScope.inputDisabled !== inputDisabled
  ) {
    setModeScope({ runtimeTabId, loading, inputDisabled });
    if (loading || modeScope.runtimeTabId !== runtimeTabId || inputDisabled) setAnnotating(false);
  }
  const dictationStartUrl = useClientSettings((settings) => settings.annotationDictationUrl);
  const dictationStopUrl = useClientSettings((settings) => settings.annotationDictationStopUrl);
  const dictation = { startUrl: dictationStartUrl, stopUrl: dictationStopUrl };
  const origin = pageOrigin(pageUrl);
  const available = origin !== null && target !== null && !inputDisabled;
  const pagePins =
    origin !== null &&
    (annotations ?? []).some((annotation) => annotationBelongsToOrigin(annotation, origin));

  const applyMode = (active: boolean) => {
    if (runtimeTabId === null || !available) return;
    if (runServerAnnotation) {
      if (runServerAnnotation(active, dictation)) setAnnotating(active);
      return;
    }
    const webview = readyWebview(runtimeTabId);
    if (webview === null) return;
    const run = async () => {
      if (active) await injectOverlay(webview, overlayOptions(dictation, "host"));
      return setOverlayMode(webview, active);
    };
    void run().then(
      (state) => setAnnotating(state === true),
      () => setAnnotating(false),
    );
  };
  const showPins = useEffectEvent((tabId: string) => {
    if (inputDisabled) return;
    if (runServerAnnotation) {
      runServerAnnotation(false, dictation);
      return;
    }
    const webview = readyWebview(tabId);
    if (webview !== null)
      void injectOverlay(webview, overlayOptions(dictation, "host")).catch(() => {});
  });
  const configureOverlay = useEffectEvent((tabId: string, next: AnnotationDictation) => {
    if (runServerAnnotation) {
      if (!inputDisabled && annotating) runServerAnnotation(true, next);
      return;
    }
    // The desktop sends dictation requests, so the page never gets the URLs.
    void previewBridge?.setAnnotationDictation?.(tabId, hostDictationUrls(next)).catch(() => {});
    const webview = readyWebview(tabId);
    if (webview !== null)
      void executeReadyWebviewScript(
        webview,
        annotationOverlayConfigureScript(overlayOptions(next, "host")),
      );
  });

  // oxlint-disable-next-line t3code/react-effect-budget -- The shortcut must win over the shell's and the focused page's key handling.
  useEffect(() => {
    const handleKey = (event: KeyboardEvent) =>
      handleBrowserAnnotationKey(
        event,
        { focused: isPreviewFocused(), active: annotating, disabled: !available },
        applyMode,
      );
    window.addEventListener("keydown", handleKey, true);
    return () => window.removeEventListener("keydown", handleKey, true);
  }, [annotating, available, applyMode]);

  // oxlint-disable-next-line t3code/react-effect-budget -- Each loaded document that has annotations gets the overlay, so its pins show.
  useEffect(() => {
    if (!loading && pagePins && runtimeTabId !== null) showPins(runtimeTabId);
  }, [loading, pagePins, runtimeTabId]);

  // oxlint-disable-next-line t3code/react-effect-budget -- The tab's dictation URLs reach the desktop, and changed settings the running overlay, without a reload.
  useEffect(() => {
    if (runtimeTabId !== null)
      configureOverlay(runtimeTabId, { startUrl: dictationStartUrl, stopUrl: dictationStopUrl });
  }, [dictationStartUrl, dictationStopUrl, runtimeTabId]);

  if (runtimeTabId === null) return null;

  return (
    <AnnotationQueuePopover
      threadRef={threadRef}
      target={target}
      annotations={annotations}
      error={error}
      annotating={annotating}
      onToggle={() => applyMode(!annotating)}
      disabled={inputDisabled}
      subject="page"
      side="bottom"
      size="icon-xs"
    />
  );
}
