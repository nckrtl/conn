import { describe, expect, it, vi } from "vite-plus/test";

import { stubGlobal } from "../../test/render";
import {
  credentialInlineCommandScript,
  credentialInlineRect,
  credentialInlineWatchScript,
  parseCredentialInlineEvent,
  type CredentialInlineEvent,
} from "./credentialInline";

const owner = "inline-test";
const run = (script: string): Promise<CredentialInlineEvent | null> => {
  // oxlint-disable-next-line no-eval -- runs the script string a guest page evaluates
  return (0, eval)(script);
};
const HTTPS_GUARD = ' || location.protocol !== "https:"';
// Browser tests are served over http; lift only the https guard, which its own test covers.
const watchOverHttp = (origin: string, revision = -1) => {
  const script = credentialInlineWatchScript(owner, origin, revision);
  expect(script).toContain(HTTPS_GUARD);
  return run(script.replace(HTTPS_GUARD, ""));
};
const next = (revision = -1) => watchOverHttp(location.origin, revision);
// A visible login field with a stubbed ResizeObserver; disposing stops the watcher first.
const loginPage = (): AsyncDisposable => {
  const resizeObserver = stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      disconnect() {}
    },
  );
  const spy = vi
    .spyOn(Element.prototype, "getBoundingClientRect")
    .mockReturnValue(new DOMRect(30, 50, 200, 40));
  document.body.innerHTML =
    '<form><input type="email" autocomplete="email"><button>Continue</button></form>';
  return {
    async [Symbol.asyncDispose]() {
      try {
        await run(credentialInlineCommandScript(owner, "dispose"));
      } finally {
        document.body.innerHTML = "";
        spy.mockRestore();
        resizeObserver[Symbol.dispose]();
      }
    },
  };
};

describe("inline login focus watcher", () => {
  it("reports focused input geometry without exposing field values", async () => {
    await using _page = loginPage();
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
    await using _page = loginPage();
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
    await using _page = loginPage();
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
    await using _page = loginPage();
    document.body.innerHTML = html;
    document.querySelector("input")!.focus();
    expect((await next())?.anchor).toBeNull();
  });
  it("rejects plain http and the wrong origin, and resolves pending reads when disposed", async () => {
    await using _page = loginPage();
    expect(await run(credentialInlineWatchScript(owner, location.origin))).toBeNull();
    expect(await watchOverHttp("https://other.example")).toBeNull();
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
