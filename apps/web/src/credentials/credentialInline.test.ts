// @vitest-environment jsdom
// @vitest-environment-options {"url":"https://login.example.com"}
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import {
  credentialInlineCommandScript,
  credentialInlineRect,
  credentialInlineWatchScript,
  parseCredentialInlineEvent,
  type CredentialInlineEvent,
} from "./credentialInline";

const owner = "inline-test";
const run = (script: string): Promise<CredentialInlineEvent | null> => {
  // oxlint-disable-next-line no-eval
  return (0, eval)(script);
};
const next = (revision = -1) => run(credentialInlineWatchScript(owner, location.origin, revision));
beforeEach(() => {
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      disconnect() {}
    },
  );
  vi.spyOn(Element.prototype, "getBoundingClientRect").mockReturnValue(
    new DOMRect(30, 50, 200, 40),
  );
  document.body.innerHTML =
    '<form><input type="email" autocomplete="email"><button>Continue</button></form>';
});
afterEach(async () => {
  await run(credentialInlineCommandScript(owner, "dispose"));
  document.body.innerHTML = "";
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("inline login focus watcher", () => {
  it("reports focused input geometry without exposing field values", async () => {
    const initial = await next();
    const pending = next(initial!.revision);
    const input = document.querySelector("input")!;
    input.value = "private@example.invalid";
    input.focus();
    const event = await pending;
    expect(event?.kind).toBe("focus");
    expect(event?.anchor).toMatchObject({
      field: "username",
      x: 30,
      y: 50,
      width: 200,
      height: 40,
    });
    expect(JSON.stringify(event)).not.toContain("private");
    expect(parseCredentialInlineEvent(event)).toEqual(event);
  });
  it("dismisses on Escape and reopens only on a new field interaction", async () => {
    document.querySelector("input")!.focus();
    const initial = await next();
    const pending = next(initial!.revision);
    document
      .querySelector("input")!
      .dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    expect((await pending)?.anchor).toBeNull();
    const dismissed = await next();
    const reopened = next(dismissed!.revision);
    document.querySelector("input")!.dispatchEvent(new Event("pointerdown", { bubbles: true }));
    expect((await reopened)?.anchor?.field).toBe("username");
  });
  it("hands ArrowDown to the picker only while it is open", async () => {
    document.querySelector("input")!.focus();
    const initial = await next();
    const key = () =>
      new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true, cancelable: true });
    const closed = key();
    document.querySelector("input")!.dispatchEvent(closed);
    expect(closed.defaultPrevented).toBe(false);
    await run(credentialInlineCommandScript(owner, "keyboard", true));
    const pending = next(initial!.revision);
    const open = key();
    document.querySelector("input")!.dispatchEvent(open);
    expect(open.defaultPrevented).toBe(true);
    expect((await pending)?.kind).toBe("keyboard");
  });
  it.each([
    '<input type="search" name="search">',
    '<input type="text" name="comment">',
    '<form><input type="email"><input type="password" autocomplete="new-password"></form>',
    '<input type="email" readonly>',
  ])("ignores non-login and registration inputs: %s", async (html) => {
    document.body.innerHTML = html;
    document.querySelector("input")!.focus();
    expect((await next())?.anchor).toBeNull();
  });
  it("rejects the wrong origin and resolves pending reads when disposed", async () => {
    expect(await run(credentialInlineWatchScript(owner, "https://other.example"))).toBeNull();
    const initial = await next();
    const pending = next(initial!.revision);
    await run(credentialInlineCommandScript(owner, "dispose"));
    expect(await pending).toBeNull();
  });
  it("rejects malformed geometry and scales guest coordinates into the host", () => {
    const anchor = {
      field: "username" as const,
      x: 30,
      y: 50,
      width: 200,
      height: 40,
      viewportWidth: 1000,
      viewportHeight: 800,
    };
    expect(
      parseCredentialInlineEvent({
        revision: 1,
        kind: "focus",
        anchor: { ...anchor, width: Infinity },
      }),
    ).toBeNull();
    expect(
      parseCredentialInlineEvent({ revision: 1, kind: "focus", anchor: { ...anchor, y: 900 } }),
    ).toBeNull();
    expect(credentialInlineRect(anchor, new DOMRect(100, 200, 500, 400))).toEqual(
      new DOMRect(115, 225, 100, 20),
    );
  });
});
