import type { CredentialField } from "@t3tools/contracts";
import { credentialFieldExpression } from "@t3tools/shared/credentialFill";

/** Which sign-in inputs a page shows right now. */
export interface CredentialPageFields {
  readonly username: boolean;
  readonly password: boolean;
  readonly otp: boolean;
  /** True when the page is a sign-in step at all. */
  readonly any: boolean;
  /** Empty, existing-login fields only; input values never leave the page. */
  readonly empty: ReadonlyArray<CredentialField>;
}

export const EMPTY_PAGE_FIELDS: CredentialPageFields = {
  username: false,
  password: false,
  otp: false,
  any: false,
  empty: [],
};

/**
 * A one-time code input only counts when it says so: the fill finder's
 * "the only text input" fallback would light the key on every search page.
 */
const OTP_SIGNAL =
  /one[-_ ]?time|otp|totp|2fa|mfa|verification|security[-_ ]?code|auth(entication)?[-_ ]?code|passcode/i;

/** Evaluates in the guest page; reads only which inputs exist, never values. */
export function credentialPageFieldsScript(): string {
  return `(() => {
  const passwordInput = ${credentialFieldExpression("password")};
  const password = Boolean(passwordInput);
  const usernameInput = ${credentialFieldExpression("username")};
  // Email-first sign-ins have no password yet. Require an account hint so the
  // field finder's single-text-input fallback does not flag arbitrary forms.
  const username = Boolean(usernameInput && (password || usernameInput.type === "email" ||
    (usernameInput.getAttribute("autocomplete") || "").toLowerCase().split(/\\s+/)
      .some((token) => token === "username" || token === "email") ||
    /user|login|e-?mail|account|identifier/i.test([
      usernameInput.name, usernameInput.id, usernameInput.getAttribute("aria-label"), usernameInput.placeholder,
    ].filter(Boolean).join(" "))));
  const otp = Array.from(document.querySelectorAll("input")).some((input) => {
    const rect = input.getBoundingClientRect();
    if (input.disabled || input.readOnly || rect.width === 0 || rect.height === 0) return false;
    if ((input.getAttribute("autocomplete") || "").includes("one-time-code")) return true;
    const text = [input.name, input.id, input.getAttribute("aria-label"), input.placeholder]
      .filter(Boolean)
      .join(" ");
    return ${OTP_SIGNAL.toString()}.test(text);
  });
  const otpInput = otp ? ${credentialFieldExpression("otp")} : null;
  const empty = [];
  if (username && usernameInput.value === "") empty.push("username");
  if (password && passwordInput.value === "" &&
      !(passwordInput.autocomplete || "").toLowerCase().split(/\\s+/).includes("new-password")) empty.push("password");
  if (otpInput && otpInput.value === "") empty.push("otp");
  return { username, password, otp, empty };
})()`;
}

interface ScriptableWebview extends Element {
  readonly executeJavaScript: (code: string) => Promise<unknown>;
}

const findWebview = (runtimeTabId: string): ScriptableWebview | null =>
  Array.from(document.querySelectorAll<ScriptableWebview>("webview[data-preview-tab]")).find(
    (candidate) => candidate.getAttribute("data-preview-tab") === runtimeTabId,
  ) ?? null;

/** Asks the tab's page which sign-in inputs it shows. Any failure reads as none. */
export async function detectCredentialPageFields(
  runtimeTabId: string,
): Promise<CredentialPageFields> {
  const webview = findWebview(runtimeTabId);
  if (!webview) return EMPTY_PAGE_FIELDS;
  try {
    const result = (await webview.executeJavaScript(credentialPageFieldsScript())) as {
      readonly username?: unknown;
      readonly password?: unknown;
      readonly otp?: unknown;
      readonly empty?: unknown;
    } | null;
    const username = result?.username === true;
    const password = result?.password === true;
    const otp = result?.otp === true;
    const empty = Array.isArray(result?.empty)
      ? result.empty.filter(
          (field): field is CredentialField =>
            field === "username" || field === "password" || field === "otp",
        )
      : [];
    return { username, password, otp, any: username || password || otp, empty };
  } catch {
    return EMPTY_PAGE_FIELDS;
  }
}
