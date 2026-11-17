import * as NodeCrypto from "node:crypto";
import {
  OrbitGatewayError,
  type OrbitGatewayEnvironment,
  type OrbitEnvironmentState,
} from "@t3tools/client-runtime/orbit-gateway";
import { AsyncResult } from "effect/reactivity";
import { describe, expect, it, vi } from "vite-plus/test";

type CatalogSnapshot = { isReady: boolean; entries?: Map<string, unknown> };

const mocks = vi.hoisted(() => ({
  readProvider: vi.fn(),
  writeProvider: vi.fn(),
  me: vi.fn(async () => ({ profile: null })),
  profiles: vi.fn(async () => []),
  environments: vi.fn<() => Promise<readonly OrbitGatewayEnvironment[]>>(async () => []),
  pair: vi.fn(),
  saveSession: vi.fn(),
  catalog: vi.fn((): CatalogSnapshot => ({ isReady: false })),
  setEnabled: vi.fn(),
  subscribe: vi.fn<(_atom: string, _listener: (catalog: CatalogSnapshot) => void) => () => void>(
    () => () => {},
  ),
  threadStartsLoaded: vi.fn(() => false),
  lacksScope: vi.fn<(environmentId: string) => boolean>(() => false),
}));

vi.mock("expo-secure-store", () => ({
  getItemAsync: mocks.readProvider,
  setItemAsync: mocks.writeProvider,
}));
vi.mock("react-native", () => ({}));
vi.mock("../../lib/uuid", () => ({ uuidv4: NodeCrypto.randomUUID }));
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
    subscribe: mocks.subscribe,
  },
}));
vi.mock("../../state/session", () => ({
  environmentSession: { sessionStateAtom: () => "session" },
  readEnvironmentLacksScope: mocks.lacksScope,
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
  orbitThreadStartStore: { loaded: mocks.threadStartsLoaded },
}));

function gatewayServer(environmentId: string, instanceId: number | null): OrbitGatewayEnvironment {
  return {
    environmentId,
    label: environmentId,
    url: `https://${environmentId}.example.test`,
    serverVersion: null,
    registeredBy: null,
    registeredAt: null,
    status: "registered",
    instanceId,
    powerState: instanceId === null ? null : "running",
    projectId: null,
    projectName: null,
    projectSlug: null,
    instanceName: null,
    nodeName: null,
    instanceUrl: null,
  };
}

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

  it.each([0, 2])("drains Connect before Default (%s failed writes)", async (failWrites) => {
    vi.resetModules();
    vi.resetAllMocks();
    let persisted = JSON.stringify({ provider: "orbit" });
    mocks.readProvider.mockImplementation(async () => persisted);
    const entries = new Map<string, { enabled: boolean; target: { _tag: string } }>();
    entries.set("manual", { enabled: true, target: { _tag: "BearerConnectionTarget" } });
    const manual = gatewayServer("manual", null);
    mocks.environments.mockResolvedValueOnce([manual]);
    mocks.catalog.mockReturnValue({ isReady: true, entries });
    mocks.setEnabled.mockImplementation(async ({ environmentId, enabled }) => {
      const entry = entries.get(environmentId);
      if (entry) entry.enabled = enabled;
      return { _tag: "Success" };
    });
    const events: string[] = [];
    let rejected = 0;
    mocks.writeProvider.mockImplementation(async (_key: string, value: string) => {
      const { provider, environments } = JSON.parse(value);
      if (
        rejected < failWrites &&
        provider === "orbit" &&
        environments.pairedByOrbit.includes("clone")
      ) {
        rejected++;
        throw new Error("Ownership write failed");
      }
      if (provider === "default") events.push("Default saved");
      persisted = value;
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
    let store = await import("./orbitGatewayStore");
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

    const connected = await connect;
    await Promise.all([switchToDefault, foregroundRefresh]);
    expect(rejected).toBe(failWrites);
    expect(events[0]).toBe("session saved");
    expect(events).toContain("Default saved");
    expect(store.orbitGatewayState()).toMatchObject({ provider: "default", phase: "idle" });
    expect(entries.get("clone")?.enabled).toBe(false);
    expect(connected).toBe(true);
    expect(JSON.parse(persisted).environments.pairedByOrbit).toEqual(["clone"]);
    expect(lateRetry).toBe(false);
    expect(lateConnect).toBe(false);
    expect(mocks.me).toHaveBeenCalledTimes(1);

    vi.resetModules();
    store = await import("./orbitGatewayStore");
    await store.refreshOrbitGateway();
    expect(entries.get("clone")?.enabled).toBe(false);
    mocks.environments.mockResolvedValueOnce([manual, gatewayServer("clone", 12)]);
    await store.setEnvironmentProvider("orbit");
    expect(entries.get("clone")?.enabled).toBe(true);
    await store.setEnvironmentProvider("default");
    expect(entries.get("clone")?.enabled).toBe(false);
    expect(entries.get("manual")?.enabled).toBe(true);
    expect(mocks.setEnabled.mock.calls).toEqual([
      [{ environmentId: "clone", enabled: false }],
      [{ environmentId: "clone", enabled: true }],
      [{ environmentId: "clone", enabled: false }],
    ]);
    expect(mocks.pair.mock.calls).toEqual([["clone", { renew: false }]]);
  });

  it.each([0, 2])("retains revocation on reload (%s failed writes)", async (failWrites) => {
    vi.resetModules();
    vi.resetAllMocks();
    let persisted = JSON.stringify({ provider: "orbit" });
    mocks.readProvider.mockImplementation(async () => persisted);
    let rejected = 0;
    const defaultSaves: string[] = [];
    mocks.writeProvider.mockImplementation(async (_key: string, value: string) => {
      const { provider, environments } = JSON.parse(value);
      if (
        rejected < failWrites &&
        provider === "orbit" &&
        environments.revokedAt.beast !== undefined
      ) {
        rejected++;
        throw new Error("Revocation write failed");
      }
      if (provider === "default") defaultSaves.push(value);
      persisted = value;
    });
    const retryStarted = Promise.withResolvers<void>();
    const retryResult = Promise.withResolvers<never>();
    mocks.pair.mockImplementationOnce(() => {
      retryStarted.resolve();
      return retryResult.promise;
    });
    let store = await import("./orbitGatewayStore");
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
    expect(rejected).toBe(failWrites);
    const firstDefault = JSON.parse(defaultSaves[0]!);
    expect(firstDefault.environments.revokedAt).toEqual({ beast: expect.any(Number) });
    expect(store.orbitGatewayState().revokedEnvironmentIds).toEqual(["beast"]);
    expect(mocks.saveSession).not.toHaveBeenCalled();

    vi.resetModules();
    store = await import("./orbitGatewayStore");
    await store.refreshOrbitGateway();
    expect(store.orbitGatewayState()).toMatchObject({
      provider: "default",
      revokedEnvironmentIds: ["beast"],
    });
    await store.setEnvironmentProvider("orbit");
    expect(await store.retryOrbitEnvironmentRenewal(server)).toBe(false);
    expect(mocks.pair).toHaveBeenCalledTimes(1);
    mocks.pair.mockResolvedValueOnce({ pairingUrl: "https://server.example.test/pair" });
    mocks.saveSession.mockResolvedValueOnce({ _tag: "Success", value: "beast" });
    expect(await store.connectOrbitEnvironment(server)).toBe(true);
    expect(store.orbitGatewayState().revokedEnvironmentIds).toEqual([]);
    expect(JSON.parse(persisted).environments.revokedAt).toEqual({});
    expect(mocks.pair.mock.calls).toEqual([
      ["beast", { renew: true }],
      ["beast", { renew: false }],
    ]);
  });
});

interface SavedProvider {
  readonly provider: "default" | "orbit";
  readonly environments: OrbitEnvironmentState;
  readonly pairingIntents?: ReadonlyArray<{
    readonly environmentId: string;
    readonly attemptId: string;
    readonly renewal: boolean;
  }>;
}

function bearer(orbitPairingAttemptId?: string) {
  return { _tag: "BearerConnectionTarget", orbitPairingAttemptId };
}

function setupRestart(pairedByOrbit = ["beast"]) {
  vi.resetAllMocks();
  vi.resetModules();
  let disk = JSON.stringify({
    provider: "orbit",
    environments: {
      pairedByOrbit,
      revokedAt: { revoked: 7 },
      renewalFailed: { beast: { at: 5, reason: "server_unreachable" } },
    },
  });
  let rejectWrite = (_next: SavedProvider) => false;
  let rejectedWrites = 0;
  const entries = new Map(
    ["manual", "beast", "revoked"].map((id) => [id, { enabled: true, target: bearer() }]),
  );
  const servers = [...entries.keys()].map((id) => gatewayServer(id, null));
  servers.push(gatewayServer("clone", 10));
  mocks.catalog.mockReturnValue({ isReady: true, entries });
  mocks.environments.mockResolvedValue(servers);
  mocks.setEnabled.mockImplementation(async ({ environmentId, enabled }) => {
    const entry = entries.get(environmentId);
    if (entry) entry.enabled = enabled;
    return { _tag: "Success" };
  });
  mocks.readProvider.mockImplementation(async () => disk);
  mocks.writeProvider.mockImplementation(async (_key: string, value: string) => {
    const next: SavedProvider = JSON.parse(value);
    if (rejectWrite(next)) {
      rejectedWrites++;
      throw new Error("Provider write failed");
    }
    disk = value;
  });
  mocks.pair.mockResolvedValue({ pairingUrl: "https://server.example.test/pair" });

  const save = ({
    expectedEnvironmentId,
    orbitPairingAttemptId,
  }: {
    readonly expectedEnvironmentId: string;
    readonly orbitPairingAttemptId: string;
  }) => {
    entries.set(expectedEnvironmentId, { enabled: true, target: bearer(orbitPairingAttemptId) });
    return { _tag: "Success", value: expectedEnvironmentId };
  };
  mocks.saveSession.mockImplementation(async (_registry, _command, input) => save(input));
  return {
    entries,
    save,
    rejectWhen: (predicate: typeof rejectWrite) => {
      rejectWrite = predicate;
    },
    rejectedWrites: () => rejectedWrites,
    disk: (): SavedProvider => JSON.parse(disk),
    async restart() {
      vi.resetModules();
      const store = await import("./orbitGatewayStore");
      await store.refreshOrbitGateway();
      return store;
    },
  };
}

const beast = { environmentId: "beast", registeredAt: null };
const clone = { environmentId: "clone", registeredAt: null };
const revoked = { environmentId: "revoked", registeredAt: null };

describe("Orbit pairing recovery after restart", () => {
  it("disables only the saved Orbit clone when both ownership writes fail", async () => {
    const mock = setupRestart([]);
    let store = await mock.restart();
    mock.rejectWhen(({ environments }) => environments.pairedByOrbit.includes("clone"));
    expect(await store.connectOrbitEnvironment(clone)).toBe(true);
    expect(mock.rejectedWrites()).toBe(2);
    expect(mock.disk().environments.pairedByOrbit).toEqual([]);
    expect(mock.disk().pairingIntents?.map((intent) => intent.environmentId)).toEqual(["clone"]);

    mock.rejectWhen(() => false);
    vi.resetModules();
    store = await import("./orbitGatewayStore");
    mocks.setEnabled.mockClear();
    mocks.me.mockClear();
    await store.setEnvironmentProvider("default");
    expect(mocks.me).not.toHaveBeenCalled();
    expect(mocks.setEnabled.mock.calls).toEqual([[{ environmentId: "clone", enabled: false }]]);
    expect(mock.entries.get("clone")?.enabled).toBe(false);
    expect(mock.entries.get("manual")?.enabled).toBe(true);
    expect(mock.entries.get("revoked")?.enabled).toBe(true);
    expect(mock.disk().environments.pairedByOrbit).toEqual(["clone"]);
  });

  it("leaves a manually saved clone enabled when Connect never saved a session", async () => {
    const mock = setupRestart([]);
    let store = await mock.restart();
    const started = Promise.withResolvers<void>();
    mocks.pair.mockImplementationOnce(() => {
      started.resolve();
      return new Promise<never>(() => {});
    });
    void store.connectOrbitEnvironment(clone);
    await started.promise;
    mock.entries.set("clone", { enabled: true, target: bearer("older-attempt") });

    store = await mock.restart();
    await store.setEnvironmentProvider("default");
    expect(mock.entries.get("clone")?.enabled).toBe(true);
    expect(mock.disk().environments.pairedByOrbit).toEqual([]);
  });

  it("requires Connect after both revocation writes fail and the app restarts", async () => {
    const mock = setupRestart();
    let store = await mock.restart();
    mock.rejectWhen(({ environments }) => environments.revokedAt?.beast !== undefined);
    mocks.pair.mockRejectedValueOnce(
      new OrbitGatewayError({
        code: "conn.pairing_revoked",
        message: "Pairing revoked",
        status: 409,
        details: {},
      }),
    );
    expect(await store.retryOrbitEnvironmentRenewal(beast)).toBe(false);
    expect(mock.rejectedWrites()).toBe(2);
    expect(store.orbitGatewayState().revokedEnvironmentIds).toContain("beast");

    mock.rejectWhen(() => false);
    mocks.threadStartsLoaded.mockReturnValue(true);
    mocks.lacksScope.mockImplementation((id) => id === "beast");
    store = await mock.restart();
    expect(store.orbitGatewayState().interruptedRenewalIds).toEqual(["beast"]);
    expect(await store.retryOrbitEnvironmentRenewal(beast)).toBe(false);
    expect(mocks.pair.mock.calls).toEqual([["beast", { renew: true }]]);
    mocks.lacksScope.mockReturnValue(false);
    expect(await store.connectOrbitEnvironment(beast)).toBe(true);
    expect(mocks.pair.mock.calls).toEqual([
      ["beast", { renew: true }],
      ["beast", { renew: false }],
    ]);

    store = await mock.restart();
    expect(store.orbitGatewayState().interruptedRenewalIds).toEqual([]);
    expect(store.orbitGatewayState().renewalFailed.beast).toBeUndefined();
  });

  it("clears stale revocation when the replacement was saved and both outcome writes fail", async () => {
    const mock = setupRestart();
    let store = await mock.restart();
    mock.rejectWhen(({ environments }) => environments.revokedAt?.revoked === undefined);
    expect(await store.connectOrbitEnvironment(revoked)).toBe(true);
    expect(mock.rejectedWrites()).toBe(2);
    expect(mock.disk().environments.revokedAt).toEqual({ revoked: 7 });

    mock.rejectWhen(() => false);
    mocks.catalog.mockReturnValue({ isReady: false });
    store = await mock.restart();
    const onCatalogReady = mocks.subscribe.mock.calls.find(([atom]) => atom === "catalog")?.[1];
    expect(onCatalogReady).toBeDefined();

    const recovered = Promise.withResolvers<void>();
    const unsubscribe = store.subscribeOrbitGateway(() => {
      if (store.orbitGatewayState().revokedEnvironmentIds.length === 0) recovered.resolve();
    });
    const catalog = { isReady: true, entries: mock.entries };
    mocks.catalog.mockReturnValue(catalog);
    onCatalogReady?.(catalog);
    await recovered.promise;
    unsubscribe();
    await store.refreshOrbitGateway();

    expect(store.orbitGatewayState().revokedEnvironmentIds).toEqual([]);
    expect(mock.disk().environments.revokedAt).toEqual({});
    expect(mocks.pair.mock.calls).toEqual([["revoked", { renew: false }]]);
  });

  it.each(["gateway", "saving", "saved"] as const)(
    "reconciles an interrupted renewal at the %s stage",
    async (stage) => {
      const mock = setupRestart();
      let store = await mock.restart();
      const interrupted = Promise.withResolvers<void>();
      const pending = new Promise<never>(() => {});
      if (stage === "gateway") {
        mocks.pair.mockImplementationOnce(() => {
          interrupted.resolve();
          return pending;
        });
      } else {
        mocks.saveSession.mockImplementationOnce((_registry, _command, input) => {
          if (stage === "saved") mock.save(input);
          interrupted.resolve();
          return pending;
        });
      }

      void store.retryOrbitEnvironmentRenewal(beast);
      await interrupted.promise;
      expect(mock.disk().pairingIntents?.[0]).toMatchObject({
        environmentId: "beast",
        renewal: true,
      });
      store = await mock.restart();

      if (stage === "saved") {
        expect(store.orbitGatewayState().interruptedRenewalIds).toEqual([]);
        expect(store.orbitGatewayState().renewalFailed.beast).toBeUndefined();
      } else {
        expect(store.orbitGatewayState().interruptedRenewalIds).toEqual(["beast"]);
        expect(await store.retryOrbitEnvironmentRenewal(beast)).toBe(false);
        expect(mocks.pair).toHaveBeenCalledTimes(1);
      }
    },
  );

  it("does not start pairing when saving intent fails and allows retry after restart", async () => {
    const mock = setupRestart();
    let store = await mock.restart();
    mock.rejectWhen(({ pairingIntents }) => (pairingIntents?.length ?? 0) > 0);
    expect(await store.retryOrbitEnvironmentRenewal(beast)).toBe(false);
    expect(mocks.pair).not.toHaveBeenCalled();
    expect(mocks.saveSession).not.toHaveBeenCalled();
    expect(mock.disk().pairingIntents).toEqual([]);

    mock.rejectWhen(() => false);
    store = await mock.restart();
    expect(store.orbitGatewayState().interruptedRenewalIds).toEqual([]);
    expect(await store.retryOrbitEnvironmentRenewal(beast)).toBe(true);
    expect(store.orbitGatewayState().renewalFailed.beast).toBeUndefined();
    expect(mocks.pair.mock.calls).toEqual([["beast", { renew: true }]]);
  });
});
