import { act, createElement } from "react";
import { create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";
import { CredentialItemId, EnvironmentId, PreviewTabId, ThreadId } from "@t3tools/contracts";
import { EMPTY_PAGE_FIELDS } from "./credentialPageFields";

const mocks = vi.hoisted(() => ({
  fields: { username: true, password: false, otp: false, any: true, empty: ["username"] },
  fill: vi.fn(),
  list: vi.fn(),
  refresh: vi.fn(),
  toast: vi.fn(),
  submit: vi.fn(),
}));
const item = {
  id: CredentialItemId.make("00000000-0000-4000-8000-000000000001"),
  title: "Fixture login",
  username: "test@example.invalid",
  source: "vault" as const,
};
vi.mock("./credentialPageFields", async (original) => ({
  ...(await original<typeof import("./credentialPageFields")>()),
  detectCredentialPageFields: async () => mocks.fields,
}));
vi.mock("./useVaultLogins", () => ({
  useVaultLogins: () => ({
    supported: true,
    busy: false,
    result: { status: "ok", items: [item] },
    refresh: mocks.refresh,
  }),
}));
vi.mock("~/state/credentials", () => ({ credentialsEnvironment: { listForSite: () => null } }));
vi.mock("~/state/query", () => ({ useEnvironmentQuery: () => ({ data: { items: [] } }) }));
vi.mock("~/state/use-atom-command", () => ({ useAtomCommand: () => mocks.fill }));
vi.mock("~/components/preview/previewAutomationClientId", () => ({
  readPreviewAutomationClientId: () => "client",
}));
vi.mock("./credentialSubmit", () => ({ submitCredentialStep: mocks.submit }));
vi.mock("./TestLoginDialog", () => ({ TestLoginDialog: () => null }));
vi.mock("./CredentialInlineSuggestions", () => ({ CredentialInlineSuggestions: () => null }));
vi.mock("~/components/ui/toast", () => ({ toastManager: { add: mocks.toast } }));
vi.mock("~/components/ui/tooltip", () => ({
  Tooltip: "tooltip",
  TooltipPopup: "tooltip-popup",
  TooltipTrigger: "tooltip-trigger",
}));
vi.mock("~/components/ui/button", () => ({ Button: "button" }));
vi.mock("~/components/ui/spinner", () => ({ Spinner: "spinner" }));
vi.mock("~/components/ui/menu", () => ({
  Menu: "menu",
  MenuGroup: "group",
  MenuGroupLabel: "label",
  MenuItem: "menuitem",
  MenuPopup: "popup",
  MenuSeparator: "separator",
  MenuTrigger: "trigger",
}));

import { CredentialKeyButton } from "./CredentialKeyButton";
let renderer: ReactTestRenderer | undefined;
const base = {
  threadRef: { environmentId: EnvironmentId.make("env"), threadId: ThreadId.make("thread") },
  tabId: PreviewTabId.make("tab"),
  runtimeTabId: "runtime-tab",
  loading: false,
  pageUrl: "https://id.example.com/login",
};
const render = async (pageUrl: string | null, loading: boolean) => {
  await act(async () => {
    // Production parents recreate this object when navigation state changes.
    const element = createElement(CredentialKeyButton, {
      ...base,
      threadRef: { ...base.threadRef },
      pageUrl,
      loading,
    });
    if (renderer) renderer.update(element);
    else renderer = create(element);
  });
};
beforeEach(() => {
  vi.useFakeTimers();
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("window", { setTimeout, clearTimeout, desktopBridge: { vaultLogins: mocks.list } });
  vi.stubGlobal("document", { visibilityState: "visible" });
  mocks.fields = { username: true, password: false, otp: false, any: true, empty: ["username"] };
  mocks.fill.mockImplementation(async ({ input }) => ({
    _tag: "Success",
    value: { results: input.fields.map((field: string) => ({ field, status: "filled" })) },
  }));
  mocks.submit.mockResolvedValue("submitted");
  mocks.list.mockResolvedValue({ status: "ok", items: [item] });
});
afterEach(async () => {
  await act(async () => renderer?.unmount());
  renderer = undefined;
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

it("keeps the selected Vault login through loading before filling password and OTP", async () => {
  await render(base.pageUrl, false);
  const choice = renderer!.root
    .findAllByType("menuitem")
    .find((n) => !n.props.disabled && n.props.onClick);
  await act(async () => choice!.props.onClick());
  expect(mocks.fill).toHaveBeenCalledTimes(1);
  mocks.fields = { ...EMPTY_PAGE_FIELDS, empty: [] };
  await render(null, true);
  await act(() => vi.advanceTimersByTimeAsync(500));
  expect(mocks.fill).toHaveBeenCalledTimes(1);
  mocks.fields = { ...EMPTY_PAGE_FIELDS, any: true, password: true, empty: ["password"] };
  await render("https://id.example.com/password", false);
  await act(() => vi.advanceTimersByTimeAsync(750));
  expect(mocks.fill).toHaveBeenCalledTimes(2);
  expect(mocks.fill.mock.calls[1]![0].input.fields).toEqual(["password"]);
  await render(null, true);
  mocks.fields = { ...EMPTY_PAGE_FIELDS, any: true, otp: true, empty: ["otp"] };
  await render("https://id.example.com/code", false);
  await act(() => vi.advanceTimersByTimeAsync(750));
  expect(mocks.fill).toHaveBeenCalledTimes(3);
  expect(mocks.fill.mock.calls[2]![0].input.fields).toEqual(["otp"]);
});

it("does not fill when navigation lands on another origin", async () => {
  await render(base.pageUrl, false);
  const choice = renderer!.root
    .findAllByType("menuitem")
    .find((n) => !n.props.disabled && n.props.onClick);
  await act(async () => choice!.props.onClick());
  await render(null, true);
  mocks.fields = { ...EMPTY_PAGE_FIELDS, any: true, password: true, empty: ["password"] };
  await render("https://other.example.com/password", false);
  await act(() => vi.advanceTimersByTimeAsync(1500));
  expect(mocks.fill).toHaveBeenCalledTimes(1);
});

it("lets a slow Vault lookup finish through parent updates and uses the full step URL", async () => {
  await render(base.pageUrl, false);
  const choice = renderer!.root
    .findAllByType("menuitem")
    .find((n) => !n.props.disabled && n.props.onClick);
  await act(async () => choice!.props.onClick());
  let resolve!: (value: { status: string; items: (typeof item)[] }) => void;
  const pending = new Promise<{ status: string; items: (typeof item)[] }>((done) => {
    resolve = done;
  });
  mocks.list.mockReturnValueOnce(pending);
  mocks.fields = { ...EMPTY_PAGE_FIELDS, any: true, password: true, empty: ["password"] };
  const passwordUrl = "https://id.example.com/password?flow=fixture";
  await render(passwordUrl, false);
  expect(mocks.list).toHaveBeenLastCalledWith({
    action: "list",
    url: passwordUrl,
    allowUnlock: false,
  });
  await render(passwordUrl, false);
  await act(async () => resolve({ status: "ok", items: [item] }));
  expect(mocks.fill).toHaveBeenCalledTimes(2);
  expect(mocks.list).toHaveBeenCalledTimes(1);
});

it("does not label Vault's missing OTP response as a definite site mismatch", async () => {
  mocks.fields = { ...EMPTY_PAGE_FIELDS, any: true, otp: true, empty: ["otp"] };
  mocks.fill.mockResolvedValue({
    _tag: "Success",
    value: { results: [{ field: "otp", status: "item_not_found" }] },
  });
  await render(base.pageUrl, false);
  const choice = renderer!.root
    .findAllByType("menuitem")
    .find((n) => !n.props.disabled && n.props.onClick);
  await act(async () => choice!.props.onClick());
  expect(mocks.toast).toHaveBeenCalledWith(
    expect.objectContaining({
      description:
        "Vault could not provide a verification code. Check that this login has a code configured in Vault and matches this site.",
    }),
  );
});

it("polls for a delayed password, retries a disappearing field, and submits filled steps once", async () => {
  await render(base.pageUrl, false);
  const choice = renderer!.root
    .findAllByType("menuitem")
    .find((n) => !n.props.disabled && n.props.onClick);
  await act(async () => choice!.props.onClick());
  await act(() => vi.advanceTimersByTimeAsync(750));
  expect(mocks.submit.mock.calls.map((call) => call[1])).toEqual(["username"]);
  mocks.fields = { ...EMPTY_PAGE_FIELDS, empty: [] };
  await act(() => vi.advanceTimersByTimeAsync(2250));
  expect(mocks.fill).toHaveBeenCalledTimes(1);
  mocks.fields = { ...EMPTY_PAGE_FIELDS, any: true, password: true, empty: ["password"] };
  mocks.fill.mockResolvedValueOnce({
    _tag: "Success",
    value: { results: [{ field: "password", status: "field_not_found" }] },
  });
  await act(() => vi.advanceTimersByTimeAsync(750));
  expect(mocks.fill).toHaveBeenCalledTimes(2);
  expect(mocks.submit).toHaveBeenCalledTimes(1);
  await act(() => vi.advanceTimersByTimeAsync(750));
  expect(mocks.fill).toHaveBeenCalledTimes(3);
  await act(() => vi.advanceTimersByTimeAsync(750));
  expect(mocks.submit.mock.calls.map((call) => call[1])).toEqual(["username", "password"]);
  mocks.fields = { ...EMPTY_PAGE_FIELDS, any: true, otp: true, empty: ["otp"] };
  await act(() => vi.advanceTimersByTimeAsync(750));
  expect(mocks.fill.mock.calls[3]![0].input.fields).toEqual(["otp"]);
  await act(() => vi.advanceTimersByTimeAsync(1500));
  expect(mocks.submit.mock.calls.map((call) => call[1])).toEqual(["username", "password", "otp"]);
  expect(mocks.toast).not.toHaveBeenCalled();
});
