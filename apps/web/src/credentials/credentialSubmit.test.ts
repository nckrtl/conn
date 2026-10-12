// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { credentialSubmitScript, type CredentialSubmitField } from "./credentialSubmit";

const submit = (field: CredentialSubmitField, origin = location.origin, selection = "choice-1") =>
  // oxlint-disable-next-line no-eval
  (0, eval)(credentialSubmitScript(field, origin, selection));
let submissions: number;
beforeEach(() => {
  submissions = 0;
  vi.spyOn(Element.prototype, "getBoundingClientRect").mockReturnValue({
    x: 0,
    y: 0,
    width: 100,
    height: 20,
    top: 0,
    left: 0,
    right: 100,
    bottom: 20,
    toJSON: () => ({}),
  });
  document.body.innerHTML =
    '<form><input type="email" autocomplete="email" value="public@example.invalid"><button>Continue</button></form>';
  document.querySelector("form")!.addEventListener("submit", (event) => {
    event.preventDefault();
    submissions++;
  });
});
afterEach(() => {
  vi.restoreAllMocks();
  document.body.innerHTML = "";
});

describe("selected login step submission", () => {
  it.each([
    "javascript:throw new Error('React form unexpectedly submitted.')",
    "javascript:throw new Error('A React form was unexpectedly submitted. If you called form.submit() manually, consider using form.requestSubmit() instead. If you\\'re trying to use event.stopPropagation() in a submit event handler, consider also calling event.preventDefault().')",
  ])("clicks React-managed login forms with action %s", (action) => {
    document.querySelector("form")!.setAttribute("action", action);
    expect(submit("username")).toBe("submitted");
    expect(submissions).toBe(1);
    document.querySelector("input")!.type = "password";
    document.querySelector("input")!.autocomplete = "current-password";
    expect(submit("password", location.origin, "password-choice")).toBe("submitted");
    expect(submissions).toBe(2);
  });
  it("submits a filled OTP once", () => {
    const input = document.querySelector("input")!;
    input.type = "text";
    input.autocomplete = "one-time-code";
    input.value = "123456";
    expect(submit("otp")).toBe("submitted");
    expect(submit("otp")).toBe("unavailable");
    expect(submissions).toBe(1);
  });
  it("rejects arbitrary script actions and submitter destination overrides", () => {
    const form = document.querySelector("form")!;
    form.action = "javascript:alert('unexpected')";
    expect(submit("username")).toBe("unavailable");
    form.removeAttribute("action");
    const button = document.querySelector("button")!;
    button.setAttribute("formaction", "https://other.example/login");
    expect(submit("username")).toBe("unavailable");
    button.removeAttribute("formaction");
    button.setAttribute("formtarget", "_blank");
    expect(submit("username")).toBe("unavailable");
    expect(submissions).toBe(0);
  });
  it("submits the username once, allowing a new explicit selection to retry", () => {
    expect(submit("username")).toBe("submitted");
    expect(submit("username")).toBe("unavailable");
    expect(submissions).toBe(1);
    expect(submit("username", location.origin, "choice-2")).toBe("submitted");
    expect(submissions).toBe(2);
  });
  it("waits for the password on a combined form and then submits", () => {
    document
      .querySelector("form")!
      .insertAdjacentHTML(
        "afterbegin",
        '<input type="password" autocomplete="current-password" required>',
      );
    expect(submit("username")).toBe("unavailable");
    expect(submit("password")).toBe("unavailable");
    (document.querySelector("[type=password]") as HTMLInputElement).value = "public-fixture";
    expect(submit("password")).toBe("submitted");
    expect(submissions).toBe(1);
  });
  it("waits for a disabled button and preserves validation", () => {
    const button = document.querySelector("button")!;
    button.disabled = true;
    expect(submit("username")).toBe("waiting");
    button.disabled = false;
    document.querySelector("input")!.value = "not-an-email";
    expect(submit("username")).toBe("waiting");
    document.querySelector("input")!.value = "public@example.invalid";
    expect(submit("username")).toBe("submitted");
  });
  it("does not submit across origins, on registration forms, or with ambiguous actions", () => {
    expect(submit("username", "https://other.example")).toBe("unavailable");
    document.querySelector("form")!.action = "https://other.example";
    expect(submit("username")).toBe("unavailable");
    document.querySelector("form")!.removeAttribute("action");
    document
      .querySelector("form")!
      .insertAdjacentHTML("beforeend", "<button>Sign in with SSO</button>");
    expect(submit("username")).toBe("unavailable");
    document.querySelector("button")!.remove();
    document
      .querySelector("form")!
      .insertAdjacentHTML(
        "afterbegin",
        '<input type="password" autocomplete="new-password" value="public-fixture">',
      );
    expect(submit("password")).toBe("unavailable");
    expect(submissions).toBe(0);
  });
});
