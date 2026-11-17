import { act, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vite-plus/test";

import { OrbitEnvironmentSections } from "./OrbitEnvironmentSections";
import { SettingsOrbitConnectionRouteScreen } from "./SettingsOrbitConnectionRouteScreen";
import { SettingsOrbitRouteScreen } from "./SettingsOrbitRouteScreen";
import type { OrbitGatewayState } from "./orbitGatewayStore";

const { Children, mocks } = vi.hoisted(() => ({
  Children: ({ children }: { children?: ReactNode }) => children,
  mocks: {
    useGateway: vi.fn(),
    me: vi.fn(),
    environments: vi.fn(),
    retry: vi.fn(),
    connect: vi.fn(),
  },
}));
vi.mock("react-native", () => ({
  ActivityIndicator: () => <span>Loading</span>,
  Pressable: Children,
  TextInput: () => null,
  View: Children,
}));
vi.mock("react-native-safe-area-context", () => ({ useSafeAreaInsets: () => ({ bottom: 0 }) }));
vi.mock("@react-navigation/native", () => ({ useNavigation: () => ({}) }));
vi.mock("../../components/ui/AppSymbol", () => ({ SymbolView: () => null }));
vi.mock("../../components/ui/AppText", () => ({ AppText: Children }));
vi.mock("../../components/ui/ErrorBanner", () => ({ ErrorBanner: () => null }));
vi.mock("../../components/ui/Menu", () => ({ Menu: Children }));
vi.mock("../../components/ui/ScreenScrollView", () => ({ ScreenScrollView: Children }));
vi.mock("../../state/use-remote-environment-registry", () => ({
  useSavedRemoteConnections: () => ({
    savedConnectionsById: { beast: { environmentId: "beast" } },
  }),
}));
vi.mock("../connection/ConnectionStatusDot", () => ({ ConnectionStatusDot: () => null }));
vi.mock("../settings/components/SettingsScreen", () => ({ SettingsScreen: Children }));
vi.mock("../settings/components/SettingsSection", () => ({ SettingsSection: Children }));
vi.mock("../settings/components/SettingsRow", () => ({
  SettingsRow: ({ label, target }: { label: string; target?: string }) =>
    target ? <a href={target}>{label}</a> : <span>{label}</span>,
}));
vi.mock("./OrbitSheetButton", () => ({
  ConnectionSheetButton: ({ label, onPress }: { label: string; onPress: () => void }) => (
    <button onClick={onPress}>{label}</button>
  ),
}));
vi.mock("./orbitGatewayStore", () => ({
  useOrbitGateway: mocks.useGateway,
  retryOrbitEnvironmentRenewal: mocks.retry,
  connectOrbitEnvironment: mocks.connect,
}));
vi.mock("./orbitGatewayClient", () => ({
  orbitGatewayClient: { me: mocks.me, environments: mocks.environments },
}));

async function renderScreen(screen: ReactNode) {
  const container = document.createElement("div");
  const root = createRoot(container);
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const render = (next: ReactNode) => act(async () => root.render(next));
  await render(screen);
  return {
    container,
    render,
    async dispose() {
      await act(async () => root.unmount());
      vi.unstubAllGlobals();
    },
  };
}

it.each([
  ["settings/orbit", SettingsOrbitRouteScreen],
  ["settings/orbit/connection", SettingsOrbitConnectionRouteScreen],
] as const)(
  "opens the %s deep-link destination with zero Gateway calls when Orbit is off",
  async (_path, Screen) => {
    mocks.me.mockClear();
    mocks.environments.mockClear();
    mocks.useGateway.mockReturnValue({ provider: "default", providerLoaded: false });
    const screen = await renderScreen(<Screen />);
    try {
      expect(screen.container.textContent).toContain("Loading");
      mocks.useGateway.mockReturnValue({ provider: "default", providerLoaded: true });
      await screen.render(<Screen />);
      expect(screen.container.querySelector('a[href="SettingsEnvironments"]')?.textContent).toBe(
        "Environments",
      );
      expect(screen.container.textContent).not.toContain("Reload");
      expect(mocks.me).not.toHaveBeenCalled();
      expect(mocks.environments).not.toHaveBeenCalled();
    } finally {
      await screen.dispose();
    }
  },
);

it.each([
  {
    revoked: false,
    action: "Retry",
    status: "Could not renew: the server is not reachable.",
  },
  {
    revoked: true,
    action: "Connect",
    status: "Revoked in Orbit",
  },
])("offers $action after a saved server's session fails", async ({ revoked, action, status }) => {
  const server = {
    environmentId: "beast",
    instanceId: null,
    label: "Beast",
    status: "registered",
    url: "https://beast.example.test",
  };
  mocks.useGateway.mockReturnValue({
    node: { profile: null },
    profiles: [],
    environments: [server],
    revokedEnvironmentIds: revoked ? ["beast"] : [],
    renewalFailed: revoked ? {} : { beast: { at: 5, reason: "server_unreachable" } },
  } satisfies Partial<Omit<OrbitGatewayState, "node" | "environments">> & {
    node: { profile: null };
    environments: ReadonlyArray<typeof server>;
  });
  const recover = revoked ? mocks.connect : mocks.retry;
  recover.mockResolvedValueOnce(false);
  const screen = await renderScreen(<OrbitEnvironmentSections />);
  try {
    const button = () =>
      [...screen.container.querySelectorAll("button")].find(
        (entry) => entry.textContent === action,
      );
    expect(screen.container.textContent).toContain(status);
    expect(screen.container.textContent).not.toContain("Paired");
    expect(button()).toBeDefined();

    await act(async () => button()?.click());

    expect(recover).toHaveBeenCalledWith(server);
    expect(screen.container.textContent).toContain(status);
    expect(button()).toBeDefined();
  } finally {
    await screen.dispose();
  }
});
