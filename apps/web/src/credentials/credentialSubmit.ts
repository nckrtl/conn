import { credentialFieldExpression } from "@t3tools/shared/credentialFill";

export type CredentialSubmitField = "username" | "password" | "otp";
export type CredentialSubmitResult = "submitted" | "waiting" | "unavailable";

// React's action functions use these inert sentinels instead of a destination.
// Click the button so React handles the submit event; never evaluate the action.
const REACT_FORM_ACTIONS = [
  "javascript:throw new Error('React form unexpectedly submitted.')",
  "javascript:throw new Error('A React form was unexpectedly submitted. If you called form.submit() manually, consider using form.requestSubmit() instead. If you\\'re trying to use event.stopPropagation() in a submit event handler, consider also calling event.preventDefault().')",
];

/** Click the filled input's own submit button; never route a keyboard event. */
export function credentialSubmitScript(
  field: CredentialSubmitField,
  origin: string,
  selectionId: string,
): string {
  return `(() => {
    if (location.origin !== ${JSON.stringify(origin)}) return "unavailable";
    const input = ${credentialFieldExpression(field)};
    if (!input || !input.value || !input.form) return "unavailable";
    const form = input.form;
    const visible = (element) => {
      const rect = element.getBoundingClientRect(), style = getComputedStyle(element);
      return rect.width > 0 && rect.height > 0 && style.visibility !== "hidden" && style.display !== "none";
    };
    // A combined login form must wait until its password has been filled too.
    if (${JSON.stringify(field)} === "username" &&
        Array.from(form.elements).some(e => e instanceof HTMLInputElement && e.type === "password" && visible(e))) return "unavailable";
    if (Array.from(form.elements).some(e => e instanceof HTMLInputElement &&
        (e.autocomplete || "").toLowerCase().split(/\\s+/).includes("new-password"))) return "unavailable";
    const buttons = Array.from(form.elements).filter(e =>
      (e instanceof HTMLButtonElement || e instanceof HTMLInputElement) && e.type === "submit" && visible(e));
    // Multiple actions (for example, SSO and password) require a manual choice.
    if (buttons.length !== 1) return "unavailable";
    const button = buttons[0];
    const action = button.getAttribute("formaction") ?? form.getAttribute("action") ?? "";
    const target = button.getAttribute("formtarget") ?? form.target;
    if ((!${JSON.stringify(REACT_FORM_ACTIONS)}.includes(action) &&
         new URL(action || location.href, location.href).origin !== location.origin) ||
        (target && target !== "_self")) return "unavailable";
    if (button.disabled || button.getAttribute("aria-disabled") === "true" || !form.checkValidity()) return "waiting";
    const submitted = Symbol.for("conn.credentialStepSubmitted");
    if (input[submitted] === ${JSON.stringify(selectionId)}) return "unavailable";
    input[submitted] = ${JSON.stringify(selectionId)};
    button.click();
    return "submitted";
  })()`;
}

export async function submitCredentialStep(
  runtimeTabId: string,
  field: CredentialSubmitField,
  origin: string,
  selectionId: string,
): Promise<CredentialSubmitResult> {
  const webview = Array.from(
    document.querySelectorAll<
      Element & {
        executeJavaScript(code: string): Promise<unknown>;
      }
    >("webview[data-preview-tab]"),
  ).find((e) => e.getAttribute("data-preview-tab") === runtimeTabId);
  if (!webview) return "unavailable";
  try {
    const result = await webview.executeJavaScript(
      credentialSubmitScript(field, origin, selectionId),
    );
    return result === "submitted" || result === "waiting" ? result : "unavailable";
  } catch {
    // A successful submit can destroy the document before its reply returns.
    return "unavailable";
  }
}
