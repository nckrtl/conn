import type { CredentialField } from "@t3tools/contracts";

export interface CredentialInlineAnchor {
  readonly field: CredentialField;
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
  readonly viewportWidth: number;
  readonly viewportHeight: number;
}

export interface CredentialInlineEvent {
  readonly revision: number;
  readonly kind: "focus" | "layout" | "keyboard" | "dismiss";
  readonly anchor: CredentialInlineAnchor | null;
}

const WATCHER = "conn.credentialInline";

/** The guest reports form geometry only. Account labels and actions stay in the host. */
export function credentialInlineWatchScript(owner: string, origin: string, after = -1): string {
  return `(() => {
    if (location.origin !== ${JSON.stringify(origin)} || location.protocol !== "https:") return null;
    const key = Symbol.for(${JSON.stringify(WATCHER)}), owner = ${JSON.stringify(owner)};
    let state = globalThis[key];
    if (!state || state.owner !== owner) {
      state?.dispose();
      let input = null, ignored = null, resolve = null, frame = 0, revision = 0, keyboard = false;
      let latest = {revision, kind: "dismiss", anchor: null};
      const controller = new AbortController(), options = {capture: true, signal: controller.signal};
      const focused = () => {
        let element = document.activeElement;
        while (element?.shadowRoot?.activeElement) element = element.shadowRoot.activeElement;
        return element;
      };
      const kind = (element) => {
        if (!(element instanceof HTMLInputElement) || element.disabled || element.readOnly || !element.isConnected) return null;
        const style = getComputedStyle(element), rect = element.getBoundingClientRect();
        if (style.display === "none" || style.visibility !== "visible" || Number(style.opacity) === 0 || rect.width <= 0 || rect.height <= 0) return null;
        const tokens = (element.autocomplete || "").toLowerCase().split(/\\s+/);
        if (tokens.includes("new-password") || element.form?.querySelector('input[autocomplete~="new-password"]')) return null;
        if (tokens.includes("one-time-code")) return "otp";
        if (element.type === "password") return "password";
        if (!["text", "email", "tel"].includes(element.type)) return null;
        const hint = [element.name, element.id, element.getAttribute("aria-label"), element.placeholder].filter(Boolean).join(" ");
        if (/search/i.test(hint)) return null;
        if (element.type === "email" || tokens.includes("username") || tokens.includes("email") || /user|login|e-?mail|account|identifier/i.test(hint)) return "username";
        return null;
      };
      const geometry = () => {
        const field = kind(input);
        if (!field || input === ignored) return null;
        const r = input.getBoundingClientRect();
        if (r.bottom <= 0 || r.top >= innerHeight || r.right <= 0 || r.left >= innerWidth) return null;
        return {field, x:r.x, y:r.y, width:r.width, height:r.height, viewportWidth:innerWidth, viewportHeight:innerHeight};
      };
      const report = (eventKind) => {
        const anchor = geometry();
        if (eventKind === "layout" && JSON.stringify(anchor) === JSON.stringify(latest.anchor)) return;
        latest = {revision:++revision, kind:eventKind, anchor};
        const pending = resolve; resolve = null; pending?.(latest);
      };
      const resize = new ResizeObserver(() => layout());
      const layout = () => {
        if (!input || frame) return;
        frame = requestAnimationFrame(() => {frame=0; report("layout");});
      };
      const inspect = (explicit = false) => {
        const element = focused();
        if (explicit || element !== input) ignored = null;
        if (!explicit && element === input) return;
        resize.disconnect(); input = kind(element) ? element : null;
        if (input) resize.observe(input);
        report(input ? "focus" : "dismiss");
      };
      document.addEventListener("focusin", () => inspect(), options);
      document.addEventListener("focusout", () => queueMicrotask(() => inspect()), options);
      document.addEventListener("pointerdown", (event) => {
        if (event.composedPath()[0] === input) inspect(true);
        else if (!(event.composedPath()[0] instanceof HTMLInputElement)) {ignored=input; report("dismiss");}
      }, options);
      document.addEventListener("keydown", (event) => {
        if (event.key === "Escape") {ignored=input; report("dismiss");}
        if (event.key === "ArrowDown" && keyboard && geometry()) {event.preventDefault(); report("keyboard");}
      }, options);
      window.addEventListener("scroll", layout, options);
      window.addEventListener("resize", layout, options);
      const mutations = new MutationObserver(layout);
      mutations.observe(document.documentElement, {childList:true, subtree:true, attributes:true, attributeFilter:["style","class","hidden","disabled","readonly"]});
      state = {
        owner,
        next: (after) => after < latest.revision ? Promise.resolve(latest) : new Promise(done => {resolve?.(null); resolve=done;}),
        keyboard: (enabled) => {keyboard=enabled;},
        dismiss: (restore) => {ignored=input; if(restore) input?.focus({preventScroll:true}); report("dismiss");},
        dispose: () => {controller.abort();resize.disconnect();mutations.disconnect();cancelAnimationFrame(frame);resolve?.(null);delete globalThis[key];}
      };
      globalThis[key] = state;
      inspect();
    }
    return state.next(${JSON.stringify(after)});
  })()`;
}

export function credentialInlineCommandScript(
  owner: string,
  command: "dispose" | "dismiss" | "keyboard",
  value = false,
): string {
  return `(() => { const state = globalThis[Symbol.for(${JSON.stringify(WATCHER)})];
    if (state?.owner === ${JSON.stringify(owner)}) state[${JSON.stringify(command)}](${JSON.stringify(value)});
  })()`;
}

/** Reject malformed guest metadata, including off-page and unreasonable rectangles. */
export function parseCredentialInlineEvent(value: unknown): CredentialInlineEvent | null {
  if (!value || typeof value !== "object") return null;
  const event = value as Partial<CredentialInlineEvent>;
  if (
    !Number.isSafeInteger(event.revision) ||
    !["focus", "layout", "keyboard", "dismiss"].includes(event.kind ?? "")
  )
    return null;
  if (event.anchor !== null) {
    const anchor = event.anchor;
    if (!anchor || !["username", "password", "otp"].includes(anchor.field)) return null;
    if (
      ![
        anchor.x,
        anchor.y,
        anchor.width,
        anchor.height,
        anchor.viewportWidth,
        anchor.viewportHeight,
      ].every(Number.isFinite)
    )
      return null;
    if (
      anchor.width <= 0 ||
      anchor.height <= 0 ||
      anchor.viewportWidth <= 0 ||
      anchor.viewportHeight <= 0 ||
      anchor.x + anchor.width <= 0 ||
      anchor.y + anchor.height <= 0 ||
      anchor.x >= anchor.viewportWidth ||
      anchor.y >= anchor.viewportHeight
    )
      return null;
  }
  return event as CredentialInlineEvent;
}

export function credentialInlineRect(anchor: CredentialInlineAnchor, webview: DOMRect): DOMRect {
  const scaleX = webview.width / anchor.viewportWidth,
    scaleY = webview.height / anchor.viewportHeight;
  return new DOMRect(
    webview.x + anchor.x * scaleX,
    webview.y + anchor.y * scaleY,
    anchor.width * scaleX,
    anchor.height * scaleY,
  );
}
