import { describe, expect, it, vi } from "vite-plus/test";

const mocks = vi.hoisted(() => ({
  readProvider: vi.fn(),
  writeProvider: vi.fn(),
  me: vi.fn(async () => ({ profile: null })),
  profiles: vi.fn(async () => []),
  environments: vi.fn(async () => []),
  pair: vi.fn(),
  saveSession: vi.fn(),
}));

vi.mock("expo-secure-store", () => ({
  getItemAsync: mocks.readProvider,
  setItemAsync: mocks.writeProvider,
}));
vi.mock("react-native", () => ({}));
vi.mock("@t3tools/client-runtime/state/runtime", () => ({
  runAtomCommand: mocks.saveSession,
  squashAtomCommandFailure: ({ cause }: { cause: unknown }) => cause,
}));
vi.mock("../../connection/catalog", () => ({ environmentCatalog: {} }));
vi.mock("../../connection/onboarding", () => ({ connectPairingUrl: {} }));
vi.mock("../../state/atom-registry", () => ({
  appAtomRegistry: { get: () => ({ isReady: false }) },
}));
vi.mock("../../state/session", () => ({
  environmentSession: {},
  readEnvironmentLacksScope: vi.fn(),
}));
vi.mock("./orbitGatewayClient", () => ({
  orbitGatewayClient: {
    me: mocks.me,
    profiles: mocks.profiles,
    environments: mocks.environments,
    pair: mocks.pair,
  },
}));
vi.mock("./orbitProfileSync", () => ({ syncOrbitAppearance: async () => {} }));
vi.mock("./orbitThreadStartStore", () => ({
  heldOrbitInstanceIds: () => [],
  orbitThreadStartStore: {},
}));

describe("Orbit Connect persistence", () => {
  it("makes no Gateway calls when loading the saved Default provider", async () => {
    vi.resetModules();
    vi.clearAllMocks();
    mocks.readProvider.mockResolvedValue(JSON.stringify({ provider: "default" }));
    const store = await import("./orbitGatewayStore");

    await store.refreshOrbitGateway();

    expect(store.orbitGatewayState()).toMatchObject({ providerLoaded: true, provider: "default" });
    expect(mocks.me).not.toHaveBeenCalled();
    expect(mocks.profiles).not.toHaveBeenCalled();
    expect(mocks.environments).not.toHaveBeenCalled();
    expect(mocks.pair).not.toHaveBeenCalled();
  });

  it("keeps a revoked server recoverable until a retry saves the replacement session", async () => {
    vi.resetModules();
    vi.clearAllMocks();
    let persisted = JSON.stringify({
      provider: "orbit",
      environments: { pairedByOrbit: ["beast"], revokedAt: { beast: 7 } },
    });
    mocks.readProvider.mockImplementation(async () => persisted);
    mocks.writeProvider.mockImplementation(async (_key: string, value: string) => {
      persisted = value;
    });
    mocks.pair.mockResolvedValue({ pairingUrl: "https://server.example.test/pair" });
    let store = await import("./orbitGatewayStore");
    await store.refreshOrbitGateway();

    const revokedAt = () => JSON.parse(persisted).environments.revokedAt;
    mocks.saveSession
      .mockResolvedValueOnce({ _tag: "Failure", cause: new Error("Credential write failed") })
      .mockImplementationOnce(async () => {
        // The saved revocation must survive throughout onboarding, including the retry.
        expect(revokedAt()).toEqual({ beast: 7 });
        return { _tag: "Success", value: "beast" };
      });
    const server = { environmentId: "beast", registeredAt: null };

    expect(await store.connectOrbitEnvironment(server)).toBe(false);
    expect(revokedAt()).toEqual({ beast: 7 });
    expect(store.orbitGatewayState().revokedEnvironmentIds).toEqual(["beast"]);

    vi.resetModules();
    store = await import("./orbitGatewayStore");
    await store.refreshOrbitGateway();
    expect(store.orbitGatewayState().revokedEnvironmentIds).toEqual(["beast"]);

    expect(await store.connectOrbitEnvironment(server)).toBe(true);
    expect(revokedAt()).toEqual({});
    expect(store.orbitGatewayState().revokedEnvironmentIds).toEqual([]);
    expect(mocks.pair.mock.calls).toEqual([
      ["beast", { renew: false }],
      ["beast", { renew: false }],
    ]);
  });
});
