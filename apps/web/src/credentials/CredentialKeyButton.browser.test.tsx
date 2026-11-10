import type { ReactNode } from "react";
import { expect, it, vi } from "vite-plus/test";
import { CredentialItemId, EnvironmentId, PreviewTabId, ThreadId } from "@t3tools/contracts";
import { EMPTY_PAGE_FIELDS } from "./credentialPageFields";

const mocks = vi.hoisted(() => ({
  fields: { username: true, password: false, otp: false, any: true, empty: ["username"] },
  fill: vi.fn(),
  serverFill: vi.fn(),
  list: vi.fn(),
  refresh: vi.fn(),
  toast: vi.fn(),
  submit: vi.fn(),
}));
const { part } = await vi.hoisted(async () => {
  const { createElement } = await import("react");
  // Renders a mocked UI part as a plain element that keeps only its children, click and disabled state.
  const part =
    (tag: string, name?: string) =>
    (props: { children?: ReactNode; disabled?: boolean; onClick?: () => void }) =>
      createElement(
        tag,
        {
          "data-part": name,
          "data-disabled": props.disabled ? "" : undefined,
          onClick: props.onClick,
        },
        props.children,
      );
  return { part };
});
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
vi.mock("~/state/use-atom-command", () => ({ useAtomCommand: () => mocks.serverFill }));
vi.mock("./credentialSubmit", () => ({ submitCredentialStep: mocks.submit }));
vi.mock("./TestLoginDialog", () => ({ TestLoginDialog: () => null }));
vi.mock("./CredentialInlineSuggestions", () => ({ CredentialInlineSuggestions: () => null }));
vi.mock("~/components/ui/toast", () => ({ toastManager: { add: mocks.toast } }));
vi.mock("~/components/ui/tooltip", () => ({
  Tooltip: part("div", "tooltip"),
  TooltipPopup: part("div", "tooltip-popup"),
  TooltipTrigger: part("div", "tooltip-trigger"),
}));
vi.mock("~/components/ui/button", () => ({ Button: part("button") }));
vi.mock("~/components/ui/spinner", () => ({ Spinner: part("span", "spinner") }));
vi.mock("~/components/ui/menu", () => ({
  Menu: part("div", "menu"),
  MenuGroup: part("div", "group"),
  MenuGroupLabel: part("div", "label"),
  MenuItem: part("div", "menuitem"),
  MenuPopup: part("div", "popup"),
  MenuSeparator: part("div", "separator"),
  MenuTrigger: part("div", "trigger"),
}));

import { act, fakeTimers, render, stubGlobal, type Screen } from "../../test/render";
import { CredentialKeyButton } from "./CredentialKeyButton";
const base = {
  threadRef: { environmentId: EnvironmentId.make("env"), threadId: ThreadId.make("thread") },
  tabId: PreviewTabId.make("tab"),
  runtimeTabId: "runtime-tab",
  loading: false,
  pageUrl: "https://id.example.com/login",
};
// Production parents recreate threadRef when navigation state changes.
const button = (pageUrl: string | null, loading: boolean) => (
  <CredentialKeyButton
    {...base}
    threadRef={{ ...base.threadRef }}
    pageUrl={pageUrl}
    loading={loading}
  />
);

// Fake timers, the desktop Vault bridge and fresh mock state for one test.
function desktop(): Disposable {
  const timers = fakeTimers();
  const bridge = stubGlobal("desktopBridge", { vaultLogins: mocks.list, vaultFill: mocks.fill });
  mocks.fields = { username: true, password: false, otp: false, any: true, empty: ["username"] };
  mocks.fill.mockResolvedValue({ status: "filled" });
  mocks.submit.mockResolvedValue("submitted");
  mocks.list.mockResolvedValue({ status: "ok", items: [item] });
  return {
    [Symbol.dispose]() {
      bridge[Symbol.dispose]();
      timers[Symbol.dispose]();
      vi.clearAllMocks();
    },
  };
}

// Picks the Vault login from the mocked menu, which always renders its items.
async function chooseLogin(screen: Screen) {
  const choice = Array.from(screen.container.querySelectorAll("[data-part=menuitem]")).find(
    (node) => node.textContent?.includes(item.title),
  );
  expect(choice?.hasAttribute("data-disabled")).toBe(false);
  await act(() => (choice as HTMLElement).click());
}

it("keeps the selected Vault login through loading before filling password and OTP", async () => {
  using _desktop = desktop();
  await using screen = await render(button(base.pageUrl, false), { router: false });
  await chooseLogin(screen);
  expect(mocks.fill).toHaveBeenCalledTimes(1);
  // Vault fills on this desktop; the environment is never asked.
  expect(mocks.fill).toHaveBeenLastCalledWith({
    tabId: "runtime-tab",
    itemId: item.id,
    field: "username",
    expectedOrigin: "https://id.example.com",
  });
  expect(mocks.serverFill).not.toHaveBeenCalled();
  mocks.fields = { ...EMPTY_PAGE_FIELDS, empty: [] };
  await screen.rerender(button(null, true));
  await act(() => vi.advanceTimersByTimeAsync(500));
  expect(mocks.fill).toHaveBeenCalledTimes(1);
  mocks.fields = { ...EMPTY_PAGE_FIELDS, any: true, password: true, empty: ["password"] };
  await screen.rerender(button("https://id.example.com/password", false));
  await act(() => vi.advanceTimersByTimeAsync(750));
  expect(mocks.fill).toHaveBeenCalledTimes(2);
  expect(mocks.fill.mock.calls[1]![0].field).toBe("password");
  await screen.rerender(button(null, true));
  mocks.fields = { ...EMPTY_PAGE_FIELDS, any: true, otp: true, empty: ["otp"] };
  await screen.rerender(button("https://id.example.com/code", false));
  await act(() => vi.advanceTimersByTimeAsync(750));
  expect(mocks.fill).toHaveBeenCalledTimes(3);
  expect(mocks.fill.mock.calls[2]![0].field).toBe("otp");
});

it("does not fill when navigation lands on another origin", async () => {
  using _desktop = desktop();
  await using screen = await render(button(base.pageUrl, false), { router: false });
  await chooseLogin(screen);
  await screen.rerender(button(null, true));
  mocks.fields = { ...EMPTY_PAGE_FIELDS, any: true, password: true, empty: ["password"] };
  await screen.rerender(button("https://other.example.com/password", false));
  await act(() => vi.advanceTimersByTimeAsync(1500));
  expect(mocks.fill).toHaveBeenCalledTimes(1);
});

it("lets a slow Vault lookup finish through parent updates and uses the full step URL", async () => {
  using _desktop = desktop();
  await using screen = await render(button(base.pageUrl, false), { router: false });
  await chooseLogin(screen);
  let resolve!: (value: { status: string; items: (typeof item)[] }) => void;
  const pending = new Promise<{ status: string; items: (typeof item)[] }>((done) => {
    resolve = done;
  });
  mocks.list.mockReturnValueOnce(pending);
  mocks.fields = { ...EMPTY_PAGE_FIELDS, any: true, password: true, empty: ["password"] };
  const passwordUrl = "https://id.example.com/password?flow=fixture";
  await screen.rerender(button(passwordUrl, false));
  expect(mocks.list).toHaveBeenLastCalledWith({
    action: "list",
    url: passwordUrl,
    allowUnlock: false,
  });
  await screen.rerender(button(passwordUrl, false));
  await act(async () => resolve({ status: "ok", items: [item] }));
  expect(mocks.fill).toHaveBeenCalledTimes(2);
  expect(mocks.list).toHaveBeenCalledTimes(1);
});

it("does not label Vault's missing OTP response as a definite site mismatch", async () => {
  using _desktop = desktop();
  mocks.fields = { ...EMPTY_PAGE_FIELDS, any: true, otp: true, empty: ["otp"] };
  mocks.fill.mockResolvedValue({ status: "item_not_found" });
  await using screen = await render(button(base.pageUrl, false), { router: false });
  await chooseLogin(screen);
  expect(mocks.toast).toHaveBeenCalledWith(
    expect.objectContaining({
      description:
        "Vault could not provide a verification code. Check that this login has a code configured in Vault and matches this site.",
    }),
  );
});

it("polls for a delayed password, retries a disappearing field, and submits filled steps once", async () => {
  using _desktop = desktop();
  await using screen = await render(button(base.pageUrl, false), { router: false });
  await chooseLogin(screen);
  await act(() => vi.advanceTimersByTimeAsync(750));
  expect(mocks.submit.mock.calls.map((call) => call[1])).toEqual(["username"]);
  mocks.fields = { ...EMPTY_PAGE_FIELDS, empty: [] };
  await act(() => vi.advanceTimersByTimeAsync(2250));
  expect(mocks.fill).toHaveBeenCalledTimes(1);
  mocks.fields = { ...EMPTY_PAGE_FIELDS, any: true, password: true, empty: ["password"] };
  mocks.fill.mockResolvedValueOnce({ status: "field_not_found" });
  await act(() => vi.advanceTimersByTimeAsync(750));
  expect(mocks.fill).toHaveBeenCalledTimes(2);
  expect(mocks.submit).toHaveBeenCalledTimes(1);
  await act(() => vi.advanceTimersByTimeAsync(750));
  expect(mocks.fill).toHaveBeenCalledTimes(3);
  await act(() => vi.advanceTimersByTimeAsync(750));
  expect(mocks.submit.mock.calls.map((call) => call[1])).toEqual(["username", "password"]);
  mocks.fields = { ...EMPTY_PAGE_FIELDS, any: true, otp: true, empty: ["otp"] };
  await act(() => vi.advanceTimersByTimeAsync(750));
  expect(mocks.fill.mock.calls[3]![0].field).toBe("otp");
  await act(() => vi.advanceTimersByTimeAsync(1500));
  expect(mocks.submit.mock.calls.map((call) => call[1])).toEqual(["username", "password", "otp"]);
  expect(mocks.toast).not.toHaveBeenCalled();
});
