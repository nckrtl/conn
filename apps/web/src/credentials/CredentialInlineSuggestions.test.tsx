import { act, createElement } from "react";
import { create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";
import { CredentialItemId } from "@t3tools/contracts";

vi.mock("~/components/ui/popover", () => ({ Popover: "aside", PopoverPopup: "section" }));
vi.mock("~/components/ui/button", () => ({ Button: "button" }));
vi.mock("~/components/ui/spinner", () => ({ Spinner: "spinner" }));
import { CredentialInlineSuggestions } from "./CredentialInlineSuggestions";
import { trackWebviewDomReady } from "~/browser/webviewDomReady";

let renderer: ReactTestRenderer | undefined;
let report: (value: unknown) => void;
const onFocus = vi.fn(),
  onUnlock = vi.fn(),
  onChoose = vi.fn();
const focus = vi.fn();
const execute = vi.fn();
let webview: ReturnType<typeof createGuest>;
let guests: ReturnType<typeof createGuest>[];
let mutate: () => void;
let stopTracking: (() => void)[];
function createGuest() {
  const guest = Object.assign(new EventTarget(), {
    isConnected: true,
    getAttribute: () => "tab",
    executeJavaScript: execute,
    focus,
    getBoundingClientRect: () => ({ x: 0, y: 0, width: 800, height: 600 }),
  });
  stopTracking.push(trackWebviewDomReady(guest));
  return guest;
}
const ready = async (guest = webview) => {
  await act(async () => guest.dispatchEvent(new Event("dom-ready")));
};
const field = {
  field: "username",
  x: 20,
  y: 40,
  width: 200,
  height: 30,
  viewportWidth: 800,
  viewportHeight: 600,
};
const item = {
  id: CredentialItemId.make("00000000-0000-4000-8000-000000000001"),
  source: "vault" as const,
  title: "Public fixture",
  username: "test@example.invalid",
};
const props = {
  runtimeTabId: "tab",
  origin: "https://example.com",
  enabled: true,
  items: [] as (typeof item)[],
  vault: {
    supported: true,
    busy: false,
    result: { status: "locked" as "locked" | "ok", items: [] as (typeof item)[], error: null },
  },
  onFocus,
  onUnlock,
  onChoose,
};
const render = async (options = props) => {
  await act(async () => {
    const node = createElement(CredentialInlineSuggestions, options);
    if (renderer) renderer.update(node);
    else renderer = create(node);
  });
};
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  stopTracking = [];
  webview = createGuest();
  guests = [webview];
  vi.stubGlobal("document", { body: {}, querySelectorAll: () => guests, hasFocus: () => true });
  vi.stubGlobal(
    "MutationObserver",
    class {
      constructor(callback: () => void) {
        mutate = callback;
      }
      observe() {}
      disconnect() {}
    },
  );
  execute.mockImplementation((script: string) =>
    script.includes("return state.next(")
      ? new Promise((resolve) => {
          report = resolve;
        })
      : Promise.resolve(),
  );
  onUnlock.mockResolvedValue(undefined);
  onChoose.mockResolvedValue(undefined);
});
afterEach(async () => {
  await act(async () => renderer?.unmount());
  renderer = undefined;
  for (const stop of stopTracking) stop();
  vi.unstubAllGlobals();
  vi.resetAllMocks();
});

it("shows an explicit unlock action on field focus and replaces it with matches", async () => {
  await render();
  await ready();
  await act(async () => report({ revision: 1, kind: "focus", anchor: field }));
  expect(onFocus).toHaveBeenCalledTimes(1);
  expect(onUnlock).not.toHaveBeenCalled();
  const button = renderer!.root.findByType("button");
  await act(async () => button.props.onClick());
  expect(onUnlock).toHaveBeenCalledTimes(1);
  await render({
    ...props,
    items: [item],
    vault: { ...props.vault, result: { status: "ok", items: [item], error: null } },
  });
  await act(async () => renderer!.root.findByType("button").props.onClick());
  expect(onChoose).toHaveBeenCalledWith(item);
  expect(renderer!.root.findAllByType("section")).toHaveLength(0);
});
it("closes when the field is left or the browser becomes hidden", async () => {
  await render();
  await ready();
  await act(async () => report({ revision: 1, kind: "focus", anchor: field }));
  expect(renderer!.root.findAllByType("section")).toHaveLength(1);
  await act(async () => report({ revision: 2, kind: "dismiss", anchor: null }));
  expect(renderer!.root.findAllByType("section")).toHaveLength(0);
  await act(async () => report({ revision: 3, kind: "focus", anchor: field }));
  await render({ ...props, enabled: false });
  expect(renderer!.root.findAllByType("section")).toHaveLength(0);
});

it("waits for dom-ready, including when the picker mounts after the guest is ready", async () => {
  await render();
  expect(execute).not.toHaveBeenCalled();
  await ready();
  expect(execute).toHaveBeenCalledTimes(1);
  await render({ ...props, enabled: false });
  execute.mockClear();
  await render();
  expect(execute).toHaveBeenCalledTimes(1);
});

it("does not call a detached guest during project-switch cleanup or accept its late reply", async () => {
  await render();
  await ready();
  const oldReport = report;
  execute.mockClear();
  webview.isConnected = false;
  await render({ ...props, enabled: false });
  expect(execute).not.toHaveBeenCalled();
  await act(async () => oldReport({ revision: 1, kind: "focus", anchor: field }));
  expect(onFocus).not.toHaveBeenCalled();
  expect(renderer!.root.findAllByType("section")).toHaveLength(0);
});

it("clears a removed guest and waits for the replacement's own dom-ready", async () => {
  await render();
  await ready();
  await act(async () => report({ revision: 1, kind: "focus", anchor: field }));
  const oldReport = report;
  execute.mockClear();
  webview.isConnected = false;
  guests = [];
  await act(async () => mutate());
  expect(execute).not.toHaveBeenCalled();
  expect(renderer!.root.findAllByType("section")).toHaveLength(0);
  const replacement = createGuest();
  guests = [replacement];
  await act(async () => mutate());
  await ready(webview);
  expect(execute).not.toHaveBeenCalled();
  await ready(replacement);
  expect(execute).toHaveBeenCalledTimes(1);
  await act(async () => oldReport({ revision: 2, kind: "focus", anchor: field }));
  expect(onFocus).toHaveBeenCalledTimes(1);
});

it.each(["throw", "reject"])(
  "contains a synchronous or async cleanup failure: %s",
  async (failure) => {
    await render();
    await ready();
    execute.mockImplementation(() => {
      if (failure === "throw") throw new Error("guest destroyed");
      return Promise.reject(new Error("guest destroyed"));
    });
    await render({ ...props, enabled: false });
    expect(renderer!.root.findAllByType("section")).toHaveLength(0);
  },
);

it("stops on main-document navigation and ignores replies from the previous document", async () => {
  await render();
  await ready();
  await act(async () => report({ revision: 1, kind: "focus", anchor: field }));
  const oldReport = report;
  execute.mockClear();
  await act(async () =>
    webview.dispatchEvent(
      Object.assign(new Event("did-start-navigation"), {
        isMainFrame: true,
        isInPlace: false,
      }),
    ),
  );
  expect(execute).not.toHaveBeenCalled();
  expect(renderer!.root.findAllByType("section")).toHaveLength(0);
  await act(async () => oldReport({ revision: 2, kind: "focus", anchor: field }));
  expect(onFocus).toHaveBeenCalledTimes(1);
  await ready();
  expect(execute).toHaveBeenCalledTimes(1);
});
