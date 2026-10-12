import { act, createElement } from "react";
import { create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";
import { CredentialItemId } from "@t3tools/contracts";

vi.mock("~/components/ui/popover", () => ({ Popover: "aside", PopoverPopup: "section" }));
vi.mock("~/components/ui/button", () => ({ Button: "button" }));
vi.mock("~/components/ui/spinner", () => ({ Spinner: "spinner" }));
import { CredentialInlineSuggestions } from "./CredentialInlineSuggestions";

let renderer: ReactTestRenderer | undefined;
let report: (value: unknown) => void;
const onFocus = vi.fn(),
  onUnlock = vi.fn(),
  onChoose = vi.fn();
const focus = vi.fn();
const execute = vi.fn();
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
  const webview = {
    getAttribute: () => "tab",
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    executeJavaScript: execute,
    focus,
    getBoundingClientRect: () => ({ x: 0, y: 0, width: 800, height: 600 }),
  };
  vi.stubGlobal("document", { body: {}, querySelectorAll: () => [webview], hasFocus: () => true });
  vi.stubGlobal(
    "MutationObserver",
    class {
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
  vi.unstubAllGlobals();
  vi.resetAllMocks();
});

it("shows an explicit unlock action on field focus and replaces it with matches", async () => {
  await render();
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
  await act(async () => report({ revision: 1, kind: "focus", anchor: field }));
  expect(renderer!.root.findAllByType("section")).toHaveLength(1);
  await act(async () => report({ revision: 2, kind: "dismiss", anchor: null }));
  expect(renderer!.root.findAllByType("section")).toHaveLength(0);
  await act(async () => report({ revision: 3, kind: "focus", anchor: field }));
  await render({ ...props, enabled: false });
  expect(renderer!.root.findAllByType("section")).toHaveLength(0);
});
