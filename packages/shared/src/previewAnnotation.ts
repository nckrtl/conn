export interface AnnotationDictation {
  /** POSTed when a comment opens; starts the desktop dictation app. Empty turns dictation off. */
  readonly startUrl: string;
  /** POSTed when the next element is clicked, so the text lands before the next comment. */
  readonly stopUrl: string;
}

/** Overlay options for T3: no floating control (the toolbar owns the mode) and T3's dictation. */
export function overlayOptions(dictation: AnnotationDictation) {
  const startUrl = dictation.startUrl.trim();
  const stopUrl = dictation.stopUrl.trim();
  return {
    floatingControl: false,
    dictation:
      startUrl === ""
        ? { provider: "none" }
        : { provider: "post", postUrl: startUrl, ...(stopUrl ? { stopUrl } : {}), autoStart: true },
  };
}

/**
 * Script run in the page to load the overlay from the annotator. The overlay keeps its
 * pins and statuses in sync with the server. A page that already runs the overlay (its
 * own toolbar, or an earlier load) is reconfigured instead: a second copy would take
 * every click and leave the comment popup unrendered.
 */
export function overlayBootstrapScript(
  endpoint: { readonly annotationsUrl: string; readonly injectUrl: string },
  dictation: AnnotationDictation,
): string {
  const settings = JSON.stringify({ mode: "server", serviceUrl: endpoint.annotationsUrl });
  const options = JSON.stringify(overlayOptions(dictation));
  return `(() => {
  try { sessionStorage.setItem("annotate:service", ${JSON.stringify(settings)}); } catch {}
  const options = ${options};
  window.__AGENT_ANNOTATION__ = options;
  if (window.AgentAnnotation) { window.AgentAnnotation.mountAnnotation(options); return "reused"; }
  if (window.__t3AnnotatorLoaded) return "loading";
  window.__t3AnnotatorLoaded = true;
  const script = document.createElement("script");
  script.src = ${JSON.stringify(endpoint.injectUrl)};
  script.async = true;
  document.documentElement.appendChild(script);
  return "loaded";
})()`;
}

/** Script that applies changed T3 settings to a running overlay. */
export function overlayConfigureScript(dictation: AnnotationDictation): string {
  const options = JSON.stringify(overlayOptions(dictation));
  return `(() => {
  const options = ${options};
  window.__AGENT_ANNOTATION__ = options;
  if (!window.AgentAnnotation) return false;
  window.AgentAnnotation.mountAnnotation(options);
  return true;
})()`;
}

/** Script that turns the overlay's annotation mode on or off (same as its shortcut). */
export function overlaySetModeScript(active: boolean): string {
  return `(() => {
  const isOn = document.documentElement.classList.contains("laravel-toolbar-annotating");
  if (isOn === ${active}) return ${active};
  const mac = navigator.platform.startsWith("Mac");
  document.dispatchEvent(new KeyboardEvent("keydown", { key: "a", code: "KeyA", metaKey: mac, ctrlKey: !mac, shiftKey: true, bubbles: true, cancelable: true }));
  return document.documentElement.classList.contains("laravel-toolbar-annotating");
})()`;
}
