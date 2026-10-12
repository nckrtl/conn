// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import { credentialPageFieldsScript, detectCredentialPageFields } from "./credentialPageFields";

// The script runs in the guest page over the webview; evaluating it here is the closest stand-in.
// oxlint-disable-next-line no-eval
const detect = () => (0, eval)(credentialPageFieldsScript()) as Record<string, unknown>;

describe("credential page detection", () => {
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

  it("finds a username and password form", () => {
    document.body.innerHTML = `<input name="login"><input type="password">`;
    expect(detect()).toEqual({
      username: true,
      password: true,
      otp: false,
      empty: ["username", "password"],
    });
  });

  it("finds Laravel's email-first sign-in before a password field exists", async () => {
    document.body.innerHTML = `<input type="hidden" name="signals"><input type="email" name="email" autocomplete="email" placeholder="Your email address">`;
    expect(detect()).toEqual({ username: true, password: false, otp: false, empty: ["username"] });
    const webview = document.createElement("webview");
    webview.setAttribute("data-preview-tab", "laravel-login");
    Object.assign(webview, { executeJavaScript: async () => detect() });
    document.body.append(webview);
    expect(await detectCredentialPageFields("laravel-login")).toEqual({
      username: true,
      password: false,
      otp: false,
      any: true,
      empty: ["username"],
    });
  });

  it("finds an explicit username-only step", () => {
    document.body.innerHTML = `<input autocomplete="section-login username">`;
    expect(detect()).toEqual({ username: true, password: false, otp: false, empty: ["username"] });
  });

  it("ignores hidden, disabled, and read-only account fields", () => {
    document.body.innerHTML = `<input type="hidden" name="username"><input type="email" disabled><input autocomplete="username" readonly>`;
    expect(detect()).toEqual({ username: false, password: false, otp: false, empty: [] });
  });

  it("finds a code step only when the input says it is one", () => {
    document.body.innerHTML = `<input autocomplete="one-time-code">`;
    expect(detect()).toEqual({ username: false, password: false, otp: true, empty: ["otp"] });
    document.body.innerHTML = `<input name="app_totp">`;
    expect(detect().otp).toBe(true);
  });

  it("does not offer automatic fill over typed values or a new-password field", () => {
    document.body.innerHTML = `<input type="email" value="already@example.invalid"><input type="password" autocomplete="new-password"><input autocomplete="one-time-code" value="123456">`;
    expect(detect().empty).toEqual([]);
  });

  it("ignores pages without a sign-in field", () => {
    document.body.innerHTML = `<input type="search" name="q"><input name="title">`;
    expect(detect()).toEqual({ username: false, password: false, otp: false, empty: [] });
  });
});
