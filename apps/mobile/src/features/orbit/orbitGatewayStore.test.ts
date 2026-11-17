import { OrbitGatewayError } from "@t3tools/client-runtime/orbit-gateway";
import { AsyncResult } from "effect/reactivity";
import { describe, expect, it, vi } from "vite-plus/test";

const mocks = vi.hoisted(() => ({
  readProvider: vi.fn(),
  writeProvider: vi.fn(),
  me: vi.fn(async () => ({ profile: null })),
  profiles: vi.fn(async () => []),
  environments: vi.fn(async () => []),
  pair: vi.fn(),
  saveSession: vi.fn(),
  catalog: vi.fn((): { isReady: boolean; entries?: Map<string, unknown> } => ({ isReady: false })),
  setEnabled: vi.fn(),
}));

vi.mock("expo-secure-store", () => ({
  getItemAsync: mocks.readProvider,
  setItemAsync: mocks.writeProvider,
}));
vi.mock("react-native", () => ({}));
vi.mock("@t3tools/client-runtime/state/runtime", () => ({
  runAtomCommand: (registry: unknown, command: unknown, input: unknown, options: unknown) =>
    command === mocks.setEnabled
      ? mocks.setEnabled(input)
      : mocks.saveSession(registry, command, input, options),
  squashAtomCommandFailure: ({ cause }: { cause: unknown }) => cause,
}));
vi.mock("../../connection/catalog", () => ({
  environmentCatalog: {
    catalogValueAtom: "catalog",
    setEnabled: mocks.setEnabled,
    stateAtom: () => "connection",
  },
}));
vi.mock("../../connection/onboarding", () => ({ connectPairingUrl: {} }));
vi.mock("../../state/atom-registry", () => ({
  appAtomRegistry: {
    get: (atom: string) => (atom === "catalog" ? mocks.catalog() : AsyncResult.initial()),
  },
}));
vi.mock("../../state/session", () => ({
  environmentSession: { sessionStateAtom: () => "session" },
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
  orbitThreadStartStore: { loaded: () => false },
}));

describe("Orbit Connect persistence", () => {
  it("makes no Gateway calls when loading the saved Default provider", async () => {
    vi.resetModules();
    vi.resetAllMocks();
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
    vi.resetAllMocks();
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

  it("drains a manual Connect through polling and session save before applying Default", async () => {
    vi.resetModules();
    vi.resetAllMocks();
    mocks.readProvider.mockResolvedValue(JSON.stringify({ provider: "orbit" }));
    const entries = new Map<string, { enabled: boolean; target: { _tag: string } }>();
    mocks.catalog.mockReturnValue({ isReady: true, entries });
    mocks.setEnabled.mockImplementation(async ({ environmentId, enabled }) => {
      const entry = entries.get(environmentId);
      if (entry) entry.enabled = enabled;
      return { _tag: "Success" };
    });
    const events: string[] = [];
    mocks.writeProvider.mockImplementation(async (_key: string, value: string) => {
      if (JSON.parse(value).provider === "default") events.push("Default saved");
    });
    const pollStarted = Promise.withResolvers<void>();
    const polled = Promise.withResolvers<{ pairingUrl: string }>();
    mocks.pair.mockImplementationOnce(() => {
      pollStarted.resolve();
      return polled.promise;
    });
    mocks.pair.mockRejectedValue(new Error("Unexpected additional pairing"));
    const saveStarted = Promise.withResolvers<void>();
    const saved = Promise.withResolvers<void>();
    mocks.saveSession.mockImplementationOnce(async () => {
      saveStarted.resolve();
      await saved.promise;
      entries.set("clone", { enabled: true, target: { _tag: "BearerConnectionTarget" } });
      events.push("session saved");
      return { _tag: "Success", value: "clone" };
    });
    const store = await import("./orbitGatewayStore");
    await store.refreshOrbitGateway();

    const connect = store.connectOrbitEnvironment({ environmentId: "clone", registeredAt: null });
    await pollStarted.promise;
    const switchToDefault = store.setEnvironmentProvider("default");
    const foregroundRefresh = store.refreshOrbitGateway();
    const other = { environmentId: "other", registeredAt: null };
    const lateRetry = await store.retryOrbitEnvironmentRenewal(other);
    polled.resolve({ pairingUrl: "https://server.example.test/pair" });
    await saveStarted.promise;
    const lateConnect = await store.connectOrbitEnvironment(other);
    saved.resolve();

    expect(await connect).toBe(true);
    await Promise.all([switchToDefault, foregroundRefresh]);
    expect(events[0]).toBe("session saved");
    expect(events).toContain("Default saved");
    expect(store.orbitGatewayState()).toMatchObject({ provider: "default", phase: "idle" });
    expect(entries.get("clone")?.enabled).toBe(false);
    expect(lateRetry).toBe(false);
    expect(lateConnect).toBe(false);
    expect(mocks.pair.mock.calls).toEqual([["clone", { renew: false }]]);
    expect(mocks.me).toHaveBeenCalledTimes(1);
  });

  it("persists a revocation from an in-flight Retry before switching to Default", async () => {
    vi.resetModules();
    vi.resetAllMocks();
    mocks.readProvider.mockResolvedValue(JSON.stringify({ provider: "orbit" }));
    const retryStarted = Promise.withResolvers<void>();
    const retryResult = Promise.withResolvers<never>();
    mocks.pair.mockImplementationOnce(() => {
      retryStarted.resolve();
      return retryResult.promise;
    });
    const store = await import("./orbitGatewayStore");
    await store.refreshOrbitGateway();

    const server = { environmentId: "beast", registeredAt: null };
    const retry = store.retryOrbitEnvironmentRenewal(server);
    await retryStarted.promise;
    const switchToDefault = store.setEnvironmentProvider("default");
    retryResult.reject(
      new OrbitGatewayError({
        code: "conn.pairing_revoked",
        message: "Pairing revoked",
        status: 409,
        details: {},
      }),
    );

    expect(await retry).toBe(false);
    await switchToDefault;
    const firstDefault = mocks.writeProvider.mock.calls
      .map(([, value]) => JSON.parse(value))
      .find((saved) => saved.provider === "default");
    expect(firstDefault.environments.revokedAt).toEqual({ beast: expect.any(Number) });
    expect(store.orbitGatewayState().revokedEnvironmentIds).toEqual(["beast"]);
    expect(mocks.saveSession).not.toHaveBeenCalled();

    await store.setEnvironmentProvider("orbit");
    expect(await store.retryOrbitEnvironmentRenewal(server)).toBe(false);
    mocks.pair.mockResolvedValueOnce({ pairingUrl: "https://server.example.test/pair" });
    mocks.saveSession.mockResolvedValueOnce({ _tag: "Success", value: "beast" });
    expect(await store.connectOrbitEnvironment(server)).toBe(true);
    expect(store.orbitGatewayState().revokedEnvironmentIds).toEqual([]);
    expect(mocks.pair.mock.calls).toEqual([
      ["beast", { renew: true }],
      ["beast", { renew: false }],
    ]);
  });
});
