import type { ReactNode } from "react";
import { expect, it, vi } from "vite-plus/test";
import { CredentialItemId } from "@t3tools/contracts";

const { part } = await vi.hoisted(async () => {
  const { createElement } = await import("react");
  // Renders a mocked UI part as a plain element that keeps only its children, click and disabled state.
  const part =
    (tag: string) => (props: { children?: ReactNode; disabled?: boolean; onClick?: () => void }) =>
      createElement(tag, { disabled: props.disabled, onClick: props.onClick }, props.children);
  return { part };
});
vi.mock("~/components/ui/popover", () => ({
  Popover: part("aside"),
  PopoverPopup: part("section"),
}));
vi.mock("~/components/ui/button", () => ({ Button: part("button") }));
vi.mock("~/components/ui/spinner", () => ({ Spinner: part("span") }));

import { act, render, type Screen } from "../../test/render";
import { CredentialInlineSuggestions } from "./CredentialInlineSuggestions";
import { trackWebviewDomReady } from "~/browser/webviewDomReady";

let report: (value: unknown) => void;
const onFocus = vi.fn(),
  onUnlock = vi.fn(),
  onChoose = vi.fn();
const focus = vi.fn();
const execute = vi.fn();

type Guest = HTMLElement & { executeJavaScript: typeof execute };

// Hosted webviews for one test. Guests are real elements, so attaching or removing one
// notifies the picker's MutationObserver.
function guestPage() {
  const stops: (() => void)[] = [];
  const guests: Guest[] = [];
  execute.mockImplementation((script: string) =>
    script.includes("return state.next(")
      ? new Promise((resolve) => {
          report = resolve;
        })
      : Promise.resolve(),
  );
  onUnlock.mockResolvedValue(undefined);
  onChoose.mockResolvedValue(undefined);
  const create = (): Guest => {
    const guest = Object.assign(document.createElement("webview"), {
      executeJavaScript: execute,
      focus,
      getBoundingClientRect: () => new DOMRect(0, 0, 800, 600),
    });
    guest.setAttribute("data-preview-tab", "tab");
    stops.push(trackWebviewDomReady(guest));
    guests.push(guest);
    return guest;
  };
  const webview = create();
  document.body.append(webview);
  return {
    webview,
    create,
    [Symbol.dispose]() {
      for (const stop of stops) stop();
      for (const guest of guests) guest.remove();
      vi.resetAllMocks();
    },
  };
}
const ready = async (guest: Guest) => {
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
const picker = (options = props) => <CredentialInlineSuggestions {...options} />;
const mount = (options = props) => render(picker(options), { router: false });
const popups = (screen: Screen) => screen.container.querySelectorAll("section");
const click = (screen: Screen) => act(() => screen.container.querySelector("button")!.click());

it("shows an explicit unlock action on field focus and replaces it with matches", async () => {
  using page = guestPage();
  await using screen = await mount();
  await ready(page.webview);
  await act(async () => report({ revision: 1, kind: "focus", anchor: field }));
  expect(onFocus).toHaveBeenCalledTimes(1);
  expect(onUnlock).not.toHaveBeenCalled();
  expect(screen.container.querySelector("button")?.textContent).toBe("Unlock Vault…");
  await click(screen);
  expect(onUnlock).toHaveBeenCalledTimes(1);
  await screen.rerender(
    picker({
      ...props,
      items: [item],
      vault: { ...props.vault, result: { status: "ok", items: [item], error: null } },
    }),
  );
  await click(screen);
  expect(onChoose).toHaveBeenCalledWith(item);
  expect(popups(screen)).toHaveLength(0);
});
it("closes when the field is left or the browser becomes hidden", async () => {
  using page = guestPage();
  await using screen = await mount();
  await ready(page.webview);
  await act(async () => report({ revision: 1, kind: "focus", anchor: field }));
  expect(popups(screen)).toHaveLength(1);
  await act(async () => report({ revision: 2, kind: "dismiss", anchor: null }));
  expect(popups(screen)).toHaveLength(0);
  await act(async () => report({ revision: 3, kind: "focus", anchor: field }));
  await screen.rerender(picker({ ...props, enabled: false }));
  expect(popups(screen)).toHaveLength(0);
});

it("waits for dom-ready, including when the picker mounts after the guest is ready", async () => {
  using page = guestPage();
  await using screen = await mount();
  expect(execute).not.toHaveBeenCalled();
  await ready(page.webview);
  expect(execute).toHaveBeenCalledTimes(1);
  await screen.rerender(picker({ ...props, enabled: false }));
  execute.mockClear();
  await screen.rerender(picker());
  expect(execute).toHaveBeenCalledTimes(1);
});

it("does not call a detached guest during project-switch cleanup or accept its late reply", async () => {
  using page = guestPage();
  await using screen = await mount();
  await ready(page.webview);
  const oldReport = report;
  execute.mockClear();
  await act(() => page.webview.remove());
  await screen.rerender(picker({ ...props, enabled: false }));
  expect(execute).not.toHaveBeenCalled();
  await act(async () => oldReport({ revision: 1, kind: "focus", anchor: field }));
  expect(onFocus).not.toHaveBeenCalled();
  expect(popups(screen)).toHaveLength(0);
});

it("clears a removed guest and waits for the replacement's own dom-ready", async () => {
  using page = guestPage();
  await using screen = await mount();
  await ready(page.webview);
  await act(async () => report({ revision: 1, kind: "focus", anchor: field }));
  const oldReport = report;
  execute.mockClear();
  await act(() => page.webview.remove());
  expect(execute).not.toHaveBeenCalled();
  expect(popups(screen)).toHaveLength(0);
  const replacement = page.create();
  await act(() => document.body.append(replacement));
  await ready(page.webview);
  expect(execute).not.toHaveBeenCalled();
  await ready(replacement);
  expect(execute).toHaveBeenCalledTimes(1);
  await act(async () => oldReport({ revision: 2, kind: "focus", anchor: field }));
  expect(onFocus).toHaveBeenCalledTimes(1);
});

it.each(["throw", "reject"])(
  "contains a synchronous or async cleanup failure: %s",
  async (failure) => {
    using page = guestPage();
    await using screen = await mount();
    await ready(page.webview);
    execute.mockImplementation(() => {
      if (failure === "throw") throw new Error("guest destroyed");
      return Promise.reject(new Error("guest destroyed"));
    });
    await screen.rerender(picker({ ...props, enabled: false }));
    expect(popups(screen)).toHaveLength(0);
  },
);

it("stops on main-document navigation and ignores replies from the previous document", async () => {
  using page = guestPage();
  await using screen = await mount();
  await ready(page.webview);
  await act(async () => report({ revision: 1, kind: "focus", anchor: field }));
  const oldReport = report;
  execute.mockClear();
  await act(async () =>
    page.webview.dispatchEvent(
      Object.assign(new Event("did-start-navigation"), {
        isMainFrame: true,
        isInPlace: false,
      }),
    ),
  );
  expect(execute).not.toHaveBeenCalled();
  expect(popups(screen)).toHaveLength(0);
  await act(async () => oldReport({ revision: 2, kind: "focus", anchor: field }));
  expect(onFocus).toHaveBeenCalledTimes(1);
  await ready(page.webview);
  expect(execute).toHaveBeenCalledTimes(1);
});
