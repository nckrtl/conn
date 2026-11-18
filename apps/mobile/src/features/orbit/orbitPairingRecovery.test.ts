import * as NodeCrypto from "node:crypto";
import {
  ConnectionOnboarding,
  Connectivity,
  EnvironmentRegistry,
  Wakeups,
} from "@t3tools/client-runtime/connection";
import {
  ClientCapabilities,
  Persistence,
  type ConnectionCatalogDocument,
} from "@t3tools/client-runtime/platform";
import { layerRemoteHttpClient } from "@t3tools/client-runtime/rpc";
import { AuthStandardClientScopes, ORCHESTRATION_PROTOCOL_VERSION } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";
import { Atom, AsyncResult } from "effect/reactivity";
import { expect, it, vi } from "vite-plus/test";

import { ConnectionDriver } from "../../../../../packages/client-runtime/src/connection/driver.ts";
import * as Storage from "../../connection/storage";
import * as SecureStorage from "../../persistence/mobile-secure-storage";

const providerKey = "t3code.environment-provider.v1";
const catalogKey = "t3code.connection-catalog.v1";
const legacyKey = "t3code.connections";
const beast = { environmentId: "beast", registeredAt: null };
const clone = { environmentId: "clone", registeredAt: null };

const native = vi.hoisted(() => ({
  read: vi.fn<(key: string) => Promise<string | null>>(),
  write: vi.fn<(key: string, value: string) => Promise<void>>(),
  remove: vi.fn<(key: string) => Promise<void>>(),
  runtime: undefined as ReturnType<typeof createRuntime> | undefined,
}));

vi.mock("expo-secure-store", () => ({
  getItemAsync: native.read,
  setItemAsync: native.write,
  deleteItemAsync: native.remove,
}));
vi.mock("expo-crypto", () => ({ randomUUID: NodeCrypto.randomUUID }));
vi.mock("react-native", () => ({}));
vi.mock("../../connection/runtime", () => ({
  get connectionAtomRuntime() {
    return native.runtime;
  },
}));
vi.mock("../../state/session", () => ({
  environmentSession: { sessionStateAtom: () => Atom.make(AsyncResult.initial()) },
  readEnvironmentLacksScope: () => false,
}));
vi.mock("./orbitProfileSync", () => ({ syncOrbitAppearance: async () => {} }));
vi.mock("./orbitThreadStartStore", () => ({
  heldOrbitInstanceIds: () => [],
  orbitThreadStartStore: { loaded: () => false },
}));

function createRuntime(fetchServer: typeof fetch) {
  const dependencies = Layer.mergeAll(
    Storage.layer.pipe(Layer.provide(SecureStorage.layer)),
    layerRemoteHttpClient(fetchServer),
    Layer.succeed(ClientCapabilities.ClientPresentation, {
      metadata: { label: "Fixture", deviceType: "desktop", os: "Fixture" },
    }),
    Layer.mock(ClientCapabilities.SshEnvironmentGateway)({}),
    Layer.mock(Persistence.EnvironmentCacheStore)({}),
    Layer.mock(Persistence.EnvironmentOwnedDataCleanup)({}),
    Connectivity.layer({
      status: Effect.succeed("online"),
      changes: Stream.never,
    }),
    Layer.succeed(Wakeups.ConnectionWakeups, { changes: Stream.never }),
    Layer.mock(ConnectionDriver)({ connect: () => Effect.never }),
  );
  return Atom.runtime(
    ConnectionOnboarding.layer.pipe(
      Layer.provideMerge(EnvironmentRegistry.layer.pipe(Layer.provideMerge(dependencies))),
    ),
  );
}

function setup({ legacyFailure = false, savedClone = false } = {}) {
  vi.resetAllMocks();
  const saved = ["beast", "manual", ...(savedClone ? ["clone"] : [])];
  const disk = new Map([
    [
      providerKey,
      JSON.stringify({
        provider: "orbit",
        environments: {
          pairedByOrbit: ["beast"],
          renewalFailed: {
            beast: legacyFailure
              ? { at: 5, reason: "server_unreachable" }
              : { at: 5, reason: "session_ended", retrySafe: true },
          },
        },
      }),
    ],
    [
      legacyKey,
      JSON.stringify({
        connections: saved.map((id) => ({
          environmentId: id,
          environmentLabel: id,
          pairingUrl: `https://${id}.example.test/pair`,
          displayUrl: `https://${id}.example.test/`,
          httpBaseUrl: `https://${id}.example.test/`,
          wsBaseUrl: `wss://${id}.example.test/`,
          bearerToken: "fixture-old",
        })),
      }),
    ],
  ]);
  const persist = async (key: string, value: string) => {
    disk.set(key, value);
  };
  native.read.mockImplementation(async (key) => disk.get(key) ?? null);
  native.write.mockImplementation(persist);
  native.remove.mockImplementation(async (key) => {
    disk.delete(key);
  });
  const catalog = (): ConnectionCatalogDocument => JSON.parse(disk.get(catalogKey)!);
  const link = (id: string) =>
    Response.json({
      data: {
        pairing: { id: 44, environment_id: id, expires_at: "2026-11-10T06:50:04Z" },
        pairing_url: `https://${id}.example.test/pair#token=fixture-once`,
      },
    });
  const pairing = vi.fn<(path: string, init: RequestInit | undefined) => Promise<Response>>();
  pairing.mockImplementation(async (path) => link(path.split("/")[2]!));
  const servers = [...saved, ...(!savedClone ? ["clone"] : [])].map((id) => ({
    environment_id: id,
    label: id,
    url: `https://${id}.example.test`,
    status: "registered",
    instance_id: id === "clone" ? 10 : null,
  }));
  const listServers = vi.fn(async () => servers);
  vi.stubGlobal("fetch", async (input: string, init?: RequestInit) => {
    const path = new URL(input).pathname.replace(/^\/api\/v1\/conn/, "");
    if (path === "/me") return Response.json({ data: { id: 5, name: "phone", profile: null } });
    if (path === "/profiles") return Response.json({ data: [] });
    if (path === "/environments") return Response.json({ data: await listServers() });
    return pairing(path, init);
  });
  const redeem = vi.fn(async () =>
    Response.json({
      access_token: "fixture-replacement",
      issued_token_type: "urn:ietf:params:oauth:token-type:access_token",
      token_type: "Bearer",
      expires_in: 3600,
      scope: AuthStandardClientScopes.join(" "),
    }),
  );
  const fetchServer: typeof fetch = async (input) => {
    const url = new URL(String(input));
    if (url.pathname === "/oauth/token") return redeem();
    if (url.pathname === "/.well-known/t3/environment") {
      return Response.json({
        environmentId: url.hostname.split(".")[0],
        label: url.hostname,
        platform: { os: "linux", arch: "arm64" },
        serverVersion: "0.0.0-test",
        orchestrationProtocolVersion: ORCHESTRATION_PROTOCOL_VERSION,
        capabilities: { repositoryIdentity: true },
      });
    }
    throw new Error(`Unexpected request: ${url.pathname}`);
  };
  let close = () => {};
  return {
    catalog,
    listServers,
    pairing,
    persist,
    redeem,
    dispose() {
      close();
      vi.unstubAllGlobals();
    },
    async launch() {
      close();
      vi.resetModules();
      native.runtime = createRuntime(fetchServer);
      const { appAtomRegistry } = await import("../../state/atom-registry");
      const { environmentCatalog } = await import("../../connection/catalog");
      const store = await import("./orbitGatewayStore");
      const atom = environmentCatalog.catalogValueAtom;
      const unmount = appAtomRegistry.mount(atom);
      close = () => {
        unmount();
        appAtomRegistry.dispose();
      };
      await vi.waitFor(() => expect(appAtomRegistry.get(atom).isReady).toBe(true));
      await store.refreshOrbitGateway();
      expect(store.orbitGatewayState().phase).toBe("ready");
      return store;
    },
  };
}

it.each(["admission reply", "operation poll", "link GET", "redemption", "catalog write"] as const)(
  "requires fresh Connect after a failed %s and relaunch",
  async (stage) => {
    const fixture = setup();
    try {
      let store = await fixture.launch();
      const lostReply = async () => {
        throw new Error("Fixture dropped the response");
      };
      if (stage === "admission reply") fixture.pairing.mockImplementationOnce(lostReply);
      if (stage === "operation poll") {
        fixture.pairing
          .mockResolvedValueOnce(
            Response.json({ data: { id: 23, status: "running" } }, { status: 202 }),
          )
          .mockImplementationOnce(lostReply);
      }
      if (stage === "link GET") {
        fixture.pairing
          .mockResolvedValueOnce(
            Response.json(
              {
                data: {
                  id: 23,
                  status: "succeeded",
                  result: { pairing_id: 44 },
                },
              },
              { status: 202 },
            ),
          )
          .mockResolvedValueOnce(
            Response.json({ error: { code: "conn.pairing_revoked" } }, { status: 409 }),
          );
      }
      if (stage === "redemption") fixture.redeem.mockImplementationOnce(lostReply);
      if (stage === "catalog write") {
        native.write.mockImplementation(async (key, value) => {
          if (key === catalogKey) throw new Error("Fixture catalog write failed");
          await fixture.persist(key, value);
        });
      }

      expect(await store.retryOrbitEnvironmentRenewal(beast)).toBe(false);
      expect(store.orbitGatewayState().interruptedRenewalIds).toEqual(["beast"]);
      expect(fixture.catalog().credentials[0]?.credential).toMatchObject({ token: "fixture-old" });
      expect(fixture.redeem).toHaveBeenCalledTimes(
        stage === "redemption" || stage === "catalog write" ? 1 : 0,
      );

      native.write.mockImplementation(fixture.persist);
      store = await fixture.launch();
      expect(store.orbitGatewayState()).toMatchObject({
        interruptedRenewalIds: ["beast"],
        revokedEnvironmentIds: [],
        renewalFailed: {},
      });
      expect(await store.retryOrbitEnvironmentRenewal(beast)).toBe(false);
      expect(await store.connectOrbitEnvironment(beast)).toBe(true);
      const admissions = fixture.pairing.mock.calls.filter(([, init]) => init?.method === "POST");
      expect(admissions.map(([, init]) => init?.body)).toEqual(['{"renew":true}', undefined]);
      expect(store.orbitGatewayState().interruptedRenewalIds).toEqual([]);
    } finally {
      fixture.dispose();
    }
  },
);

it.each(["admission refused", "terminal unauthorized"] as const)(
  "keeps Retry on relaunch when the pairing was %s",
  async (stage) => {
    const fixture = setup();
    try {
      let store = await fixture.launch();
      fixture.pairing.mockResolvedValueOnce(
        stage === "admission refused"
          ? Response.json({ error: { code: "conn.session_expired" } }, { status: 409 })
          : Response.json(
              {
                data: {
                  id: 23,
                  status: "failed",
                  error_code: "conn.session_rejected",
                },
              },
              { status: 202 },
            ),
      );
      expect(await store.retryOrbitEnvironmentRenewal(beast)).toBe(false);
      expect(fixture.redeem).not.toHaveBeenCalled();
      store = await fixture.launch();
      expect(store.orbitGatewayState().renewalFailed.beast).toMatchObject({
        reason: "session_ended",
        retrySafe: true,
      });
      expect(await store.retryOrbitEnvironmentRenewal(beast)).toBe(true);
    } finally {
      fixture.dispose();
    }
  },
);

it("treats an older failure without outcome evidence as Connect-only", async () => {
  const fixture = setup({ legacyFailure: true });
  try {
    const store = await fixture.launch();
    expect(store.orbitGatewayState().interruptedRenewalIds).toEqual(["beast"]);
    expect(await store.retryOrbitEnvironmentRenewal(beast)).toBe(false);
    expect(fixture.pairing).not.toHaveBeenCalled();
  } finally {
    fixture.dispose();
  }
});

it("disables a manually saved clone under Default after Orbit takes ownership", async () => {
  const fixture = setup({ savedClone: true });
  try {
    fixture.listServers.mockImplementationOnce(async () =>
      (await fixture.listServers()).filter((server) => server.environment_id !== "clone"),
    );
    const store = await fixture.launch();
    expect(fixture.catalog().disabledEnvironmentIds).toEqual(["clone"]);
    await store.refreshOrbitGateway();
    expect(await store.connectOrbitEnvironment(clone)).toBe(true);
    await store.setEnvironmentProvider("default");
    expect([...fixture.catalog().disabledEnvironmentIds].sort()).toEqual(["beast", "clone"]);
  } finally {
    fixture.dispose();
  }
});
