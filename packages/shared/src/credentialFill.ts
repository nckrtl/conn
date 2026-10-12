/**
 * Page-side pieces of password-manager autofill, shared by the server (which
 * builds the field finder) and the desktop main process (which runs them over
 * CDP and redacts agent-visible results).
 */

export type CredentialFillField = "username" | "password" | "otp";

/** Element property that marks an input T3 Code filled with a secret. */
const FILLED_MARK = "t3code.credentialFilled";

/** Input types a username or one-time code may be typed into. */
const TEXT_INPUT_TYPES = ["text", "email", "tel", "number", "search", "url", ""];

/**
 * An expression that evaluates, in the guest page, to the input to fill or
 * `null`. It only looks at the top document and its open shadow roots: a field
 * inside an iframe belongs to another origin as far as the fill is concerned.
 */
export function credentialFieldExpression(
  field: CredentialFillField,
  selector?: string | undefined,
): string {
  return `(() => {
  const field = ${JSON.stringify(field)};
  const selector = ${JSON.stringify(selector ?? null)};
  const textTypes = new Set(${JSON.stringify(TEXT_INPUT_TYPES)});
  const roots = [document];
  for (let index = 0; index < roots.length && roots.length < 64; index += 1) {
    for (const element of roots[index].querySelectorAll("*")) {
      if (element.shadowRoot) roots.push(element.shadowRoot);
    }
  }
  const inputs = roots.flatMap((root) => Array.from(root.querySelectorAll("input")));
  const visible = (element) => {
    const style = getComputedStyle(element);
    const rect = element.getBoundingClientRect();
    return style.visibility !== "hidden" && style.display !== "none" && rect.width > 0 && rect.height > 0;
  };
  const usable = (element) => !element.disabled && !element.readOnly && visible(element);
  const tokens = (element) => (element.getAttribute("autocomplete") || "").toLowerCase().split(/\\s+/);
  const describe = (element) =>
    [element.name, element.id, element.getAttribute("aria-label"), element.placeholder]
      .filter(Boolean)
      .join(" ");
  if (selector !== null) {
    const element = document.querySelector(selector);
    return element instanceof HTMLInputElement && usable(element) ? element : null;
  }
  const passwords = inputs.filter((element) => element.type === "password" && usable(element));
  if (field === "password") {
    return (
      passwords.find((element) => tokens(element).includes("current-password")) ||
      passwords.find((element) => !tokens(element).includes("new-password")) ||
      passwords[0] ||
      null
    );
  }
  const texts = inputs.filter(
    (element) => textTypes.has(element.type) && usable(element) && !/search/i.test(describe(element)),
  );
  if (field === "otp") {
    return (
      texts.find((element) => tokens(element).includes("one-time-code")) ||
      texts.find((element) =>
        /one[-_ ]?time|otp|totp|2fa|mfa|verification|security[-_ ]?code|auth(entication)?[-_ ]?code|passcode|\\bcode\\b/i.test(
          describe(element),
        ),
      ) ||
      (texts.length === 1 ? texts[0] : null)
    );
  }
  const firstPassword = passwords[0];
  const beforePassword = firstPassword
    ? texts.filter(
        (element) =>
          element.compareDocumentPosition(firstPassword) & Node.DOCUMENT_POSITION_FOLLOWING,
      )
    : [];
  return (
    texts.find((element) => tokens(element).some((token) => token === "username" || token === "email")) ||
    texts.find((element) => element.type === "email") ||
    texts.find((element) => /user|login|e-?mail|account|identifier/i.test(describe(element))) ||
    beforePassword[beforePassword.length - 1] ||
    (texts.length === 1 ? texts[0] : null)
  );
})()`;
}

/**
 * Runs with `this` bound to the found input. Checks the input can take this
 * field, focuses it and selects its content so the next insert replaces it.
 * Returns "ready" or a fill status.
 */
export const CREDENTIAL_PREPARE_FUNCTION = `function (field) {
  const element = this;
  const textTypes = new Set(${JSON.stringify(TEXT_INPUT_TYPES)});
  if (!(element instanceof HTMLInputElement) || element.disabled || element.readOnly) {
    return "not_editable";
  }
  // A password only goes into a masked input, so it never shows in screenshots.
  if (field === "password" ? element.type !== "password" : !textTypes.has(element.type)) {
    return "not_editable";
  }
  element.focus();
  if (element.getRootNode().activeElement !== element) return "not_editable";
  element.select();
  return "ready";
}`;

/**
 * Writes only to the bound input. CDP Input.insertText can reach the host's
 * focused composer when a webview is inactive, so credentials must never use
 * keyboard routing. The native setter also supports controlled React inputs.
 */
export const CREDENTIAL_INSERT_FUNCTION = `function (field, value, expectedOrigin) {
  const element = this;
  if (location.origin !== expectedOrigin) return "origin_mismatch";
  const textTypes = new Set(${JSON.stringify(TEXT_INPUT_TYPES)});
  if (!(element instanceof HTMLInputElement) || !element.isConnected ||
      element.ownerDocument !== document || element.disabled || element.readOnly ||
      (field === "password" ? element.type !== "password" : !textTypes.has(element.type))) {
    return "not_editable";
  }
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
  if (!setter) return "insert_failed";
  setter.call(element, value);
  if (element.value !== value) return "insert_failed";
  if (field !== "username") {
    Object.defineProperty(element, Symbol.for(${JSON.stringify(FILLED_MARK)}), {
      value: true,
      configurable: true,
    });
  }
  element.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertText" }));
  element.dispatchEvent(new Event("change", { bubbles: true }));
  return "filled";
}`;

/**
 * Evaluates to the non-empty values of every masked input and every input
 * T3 Code filled with a secret, across open shadow roots and same-origin
 * frames. The desktop strips these values from agent-visible results.
 */
export const SENSITIVE_INPUT_VALUES_EXPRESSION = `(() => {
  const mark = Symbol.for(${JSON.stringify(FILLED_MARK)});
  const values = new Set();
  const visit = (root, depth) => {
    for (const element of root.querySelectorAll("*")) {
      if (element.shadowRoot) visit(element.shadowRoot, depth);
      if (element instanceof HTMLIFrameElement && depth < 4) {
        try {
          if (element.contentDocument) visit(element.contentDocument, depth + 1);
        } catch {}
      }
      if (
        element.tagName === "INPUT" &&
        (element.type === "password" || element[mark] === true) &&
        element.value
      ) {
        values.add(element.value);
      }
    }
  };
  try {
    visit(document, 0);
  } catch {}
  return Array.from(values);
})()`;

export const REDACTED_VALUE = "[redacted]";

/** Values shorter than this are only redacted when a string equals them exactly. */
const MIN_SUBSTRING_LENGTH = 4;

const variantsOf = (secret: string): ReadonlyArray<string> => {
  const variants = new Set([secret]);
  try {
    variants.add(encodeURIComponent(secret));
  } catch {
    // Lone surrogates cannot be URI-encoded; the raw value is still covered.
  }
  variants.add(JSON.stringify(secret).slice(1, -1));
  return [...variants];
};

/**
 * Replaces every occurrence of a secret (raw, URI-encoded or JSON-escaped)
 * in strings and object keys of a JSON-like value. Other values pass through.
 */
export function redactSensitiveValues<T>(value: T, secrets: ReadonlyArray<string>): T {
  const exact = new Set<string>();
  const substrings: string[] = [];
  for (const secret of secrets) {
    if (typeof secret !== "string" || secret.length === 0) continue;
    for (const variant of variantsOf(secret)) {
      if (variant.length >= MIN_SUBSTRING_LENGTH) substrings.push(variant);
      else exact.add(variant);
    }
  }
  if (exact.size === 0 && substrings.length === 0) return value;
  substrings.sort((left, right) => right.length - left.length);
  const redactString = (text: string): string => {
    if (exact.has(text)) return REDACTED_VALUE;
    let result = text;
    for (const secret of substrings) {
      if (result.includes(secret)) result = result.split(secret).join(REDACTED_VALUE);
    }
    return result;
  };
  const visit = (current: unknown, depth: number): unknown => {
    if (typeof current === "string") return redactString(current);
    if (depth > 64 || current === null || typeof current !== "object") return current;
    if (Array.isArray(current)) return current.map((entry) => visit(entry, depth + 1));
    const prototype = Object.getPrototypeOf(current);
    if (prototype !== Object.prototype && prototype !== null) return current;
    return Object.fromEntries(
      Object.entries(current).map(([key, entry]) => [redactString(key), visit(entry, depth + 1)]),
    );
  };
  return visit(value, 0) as T;
}
