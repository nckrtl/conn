export interface AnnotationDictation {
  /** POSTed when a comment opens; starts the desktop dictation app. Empty turns dictation off. */
  readonly startUrl: string;
  /** POSTed when the next element is clicked, so the text lands before the next comment. */
  readonly stopUrl: string;
}

/**
 * Who sends the dictation requests: `host` for the desktop browser, whose guest preload defines
 * `window.__ANNOTATOR_HOST__` so a page CSP cannot block them; `post` lets the page fetch the
 * URLs itself (server browser tabs have no preload).
 */
export type AnnotationDictationSender = "host" | "post";

/** Overlay options for T3: no floating control (the toolbar owns the mode) and T3's dictation. */
export function overlayOptions(
  dictation: AnnotationDictation,
  sender: AnnotationDictationSender = "post",
) {
  const startUrl = dictation.startUrl.trim();
  const stopUrl = dictation.stopUrl.trim();
  return {
    floatingControl: false,
    dictation:
      startUrl === ""
        ? { provider: "none" }
        : sender === "host"
          ? { provider: "host", autoStart: true, stopOnNextElement: stopUrl !== "" }
          : {
              provider: "post",
              postUrl: startUrl,
              ...(stopUrl ? { stopUrl } : {}),
              autoStart: true,
            },
  };
}
