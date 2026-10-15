// Track readiness at the host ref, before toolbar effects can discover the guest.
// A toolbar can mount after dom-ready, so listening only in the toolbar loses it.
const readyWebviews = new WeakSet<EventTarget>();
type WebviewElement = EventTarget & { readonly isConnected: boolean };

export function isNewWebviewDocument(event: Event): boolean {
  const navigation = event as Event & { isMainFrame?: boolean; isInPlace?: boolean };
  return navigation.isMainFrame === true && navigation.isInPlace !== true;
}

export function isWebviewDomReady(webview: WebviewElement): boolean {
  if (!webview.isConnected) {
    readyWebviews.delete(webview);
    return false;
  }
  return readyWebviews.has(webview);
}

export function trackWebviewDomReady(webview: WebviewElement): () => void {
  const reset = () => readyWebviews.delete(webview);
  const ready = () => {
    if (webview.isConnected) readyWebviews.add(webview);
  };
  const navigate = (event: Event) => {
    if (isNewWebviewDocument(event)) reset();
  };
  reset();
  webview.addEventListener("dom-ready", ready);
  webview.addEventListener("did-start-navigation", navigate);
  webview.addEventListener("render-process-gone", reset);
  return () => {
    reset();
    webview.removeEventListener("dom-ready", ready);
    webview.removeEventListener("did-start-navigation", navigate);
    webview.removeEventListener("render-process-gone", reset);
  };
}

export async function executeReadyWebviewScript(
  webview: WebviewElement & { executeJavaScript(code: string): Promise<unknown> },
  code: string,
): Promise<unknown> {
  if (!isWebviewDomReady(webview)) return undefined;
  try {
    return await webview.executeJavaScript(code);
  } catch {
    // Electron can throw synchronously or reject after the guest goes away.
    return undefined;
  }
}
