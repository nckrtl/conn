// @vitest-environment jsdom
import {
  CREDENTIAL_INSERT_FUNCTION,
  CREDENTIAL_PREPARE_FUNCTION,
  SENSITIVE_INPUT_VALUES_EXPRESSION,
  credentialFieldExpression,
} from "@t3tools/shared/credentialFill";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

// These scripts run in the guest page over CDP; evaluating them here is the closest stand-in.
// oxlint-disable-next-line no-eval
const evaluate = (expression: string): unknown => (0, eval)(expression);
const callOn = (element: Element, declaration: string, ...args: unknown[]): unknown =>
  (evaluate(`(${declaration})`) as (...rest: unknown[]) => unknown).apply(element, args);

const find = (field: "username" | "password" | "otp", selector?: string) =>
  evaluate(credentialFieldExpression(field, selector)) as HTMLInputElement | null;

describe("credential page scripts", () => {
  beforeEach(() => {
    // jsdom has no layout; give every element a box so it counts as visible.
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
  });
  afterEach(() => {
    vi.restoreAllMocks();
    document.body.innerHTML = "";
  });

  it("finds the username and current password of a sign-in form", () => {
    document.body.innerHTML = `
      <input type="search" name="q">
      <form>
        <input type="text" id="login_field" name="login">
        <input type="password" id="new" autocomplete="new-password">
        <input type="password" id="current" autocomplete="current-password">
      </form>`;
    expect(find("username")?.id).toBe("login_field");
    expect(find("password")?.id).toBe("current");
  });

  it("falls back to the text input before the password", () => {
    document.body.innerHTML = `
      <input type="text" id="first">
      <input type="text" id="second">
      <input type="password" id="password">`;
    expect(find("username")?.id).toBe("second");
  });

  it("finds a one-time code input and skips hidden or disabled inputs", () => {
    document.body.innerHTML = `
      <input type="text" id="hidden" autocomplete="one-time-code" style="display:none">
      <input type="text" id="disabled" autocomplete="one-time-code" disabled>
      <input type="tel" id="code" name="totp_code">`;
    expect(find("otp")?.id).toBe("code");
  });

  it("uses an explicit selector and returns null when nothing fits", () => {
    document.body.innerHTML = `<input type="password" id="a"><input type="password" id="b">`;
    expect(find("password", "#b")?.id).toBe("b");
    expect(find("password", "#missing")).toBeNull();
    document.body.innerHTML = `<p>No form</p>`;
    expect(find("username")).toBeNull();
    expect(find("password")).toBeNull();
  });

  it("fills a password input, fires input events, and marks it", () => {
    document.body.innerHTML = `<input type="password" id="password" value="old">`;
    const input = document.getElementById("password") as HTMLInputElement;
    const events: string[] = [];
    input.addEventListener("input", () => events.push("input"));
    input.addEventListener("change", () => events.push("change"));
    expect(callOn(input, CREDENTIAL_PREPARE_FUNCTION, "password")).toBe("ready");
    expect(callOn(input, CREDENTIAL_INSERT_FUNCTION, "password", "s3cret", location.origin)).toBe(
      "filled",
    );
    expect(input.value).toBe("s3cret");
    expect(events).toEqual(["input", "change"]);
    expect(evaluate(SENSITIVE_INPUT_VALUES_EXPRESSION)).toEqual(["s3cret"]);
  });

  it("fills a username without marking it as a secret", () => {
    document.body.innerHTML = `<input type="text" id="user">`;
    const input = document.getElementById("user") as HTMLInputElement;
    expect(callOn(input, CREDENTIAL_PREPARE_FUNCTION, "username")).toBe("ready");
    input.value = "nick";
    expect(callOn(input, CREDENTIAL_INSERT_FUNCTION, "username", "nick", location.origin)).toBe(
      "filled",
    );
    expect(input.value).toBe("nick");
    // Usernames are not secret and are not marked for redaction.
    expect(evaluate(SENSITIVE_INPUT_VALUES_EXPRESSION)).toEqual([]);
  });

  it("refuses to put a password into a visible text input", () => {
    document.body.innerHTML = `<input type="text" id="plain"><input type="password" id="ro" readonly>`;
    expect(callOn(document.getElementById("plain")!, CREDENTIAL_PREPARE_FUNCTION, "password")).toBe(
      "not_editable",
    );
    expect(callOn(document.getElementById("ro")!, CREDENTIAL_PREPARE_FUNCTION, "password")).toBe(
      "not_editable",
    );
  });

  it("collects filled values even after the agent unmasks the input", () => {
    document.body.innerHTML = `<input type="password" id="p"><input type="text" id="t" value="visible">`;
    const input = document.getElementById("p") as HTMLInputElement;
    callOn(input, CREDENTIAL_PREPARE_FUNCTION, "password");
    callOn(input, CREDENTIAL_INSERT_FUNCTION, "password", "s3cret", location.origin);
    input.type = "text";
    expect(evaluate(SENSITIVE_INPUT_VALUES_EXPRESSION)).toEqual(["s3cret"]);
  });
});
