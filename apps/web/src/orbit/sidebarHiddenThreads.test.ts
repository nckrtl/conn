// @effect-diagnostics globalTimers:off - The profile sync runs on plain promises, outside an Effect runtime.
import {
  createProfileSync,
  OrbitGatewayError,
  type OrbitGatewayNode,
  type OrbitGatewaySectionPatch,
  type OrbitGatewaySettings,
  type ProfileSyncState,
} from "@t3tools/client-runtime/orbit-gateway";
import * as DateTime from "effect/DateTime";
import * as Option from "effect/Option";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { create } from "zustand";

import { isSidebarHiddenThread } from "./sidebarHiddenThreads.logic";

const fixture = vi.hoisted(() => ({
  ids: 0,
  shells: new Map<string, unknown>(),
  shellListeners: new Map<string, Set<(value: unknown) => void>>(),
}));

vi.mock("../lib/utils", () => ({ randomUUID: () => `id-${++fixture.ids}` }));
vi.mock("../state/shell", () => ({
  environmentShell: { stateValueAtom: (environmentId: string) => environmentId },
}));
vi.mock("../rpc/atomRegistry", () => ({
  appAtomRegistry: {
    subscribe: (
      atom: string,
      listener: (value: unknown) => void,
      options?: { immediate?: boolean },
    ) => {
      const listeners = fixture.shellListeners.get(atom) ?? new Set();
      fixture.shellListeners.set(atom, listeners);
      listeners.add(listener);
      if (options?.immediate) {
        listener(fixture.shells.get(atom) ?? { status: "connecting", snapshot: Option.none() });
      }
      return () => listeners.delete(listener);
    },
  },
}));
vi.mock("./environmentProvider", () => ({
  useEnvironmentProvider: create(() => ({
    provider: "orbit",
    state: { disabledByOrbit: [], pairedByOrbit: ["clone"] },
    orbitInstances: {},
  })),
}));

function createLocalStorageStub(): Storage {
  const values = new Map<string, string>();
  return {
    get length() {
      return values.size;
    },
    clear: () => values.clear(),
    getItem: (key) => values.get(key) ?? null,
    key: (index) => [...values.keys()][index] ?? null,
    removeItem: (key) => values.delete(key),
    setItem: (key, value) => values.set(key, value),
  };
}

/** Each import is one window: its own module state over the shared localStorage. */
async function openWindow() {
  vi.resetModules();
  const module = await import("./sidebarHiddenThreads");
  const listeners: Array<(event: { key: string | null }) => void> = [];
  return { module, listeners };
}

function setup() {
  fixture.ids = 0;
  fixture.shells.clear();
  fixture.shellListeners.clear();
  const windows: Array<Awaited<ReturnType<typeof openWindow>>> = [];
  const storage = createLocalStorageStub();
  vi.stubGlobal("window", {
    localStorage: storage,
    addEventListener: (type: string, listener: (event: { key: string | null }) => void) => {
      if (type === "storage") windows.at(-1)?.listeners.push(listener);
    },
  });
  const open = async () => {
    const opened = await openWindow();
    windows.push(opened);
    opened.module.watchSidebarHiddenThreads();
    return opened;
  };
  /** The storage event the browser sends every other window after a write. */
  const broadcast = (from: Awaited<ReturnType<typeof openWindow>>) => {
    for (const other of windows) {
      if (other !== from) for (const listener of other.listeners) listener({ key: null });
    }
  };
  /** The profile's section was read once already. */
  const hydrate = (...profiles: number[]) => {
    for (const profile of profiles) {
      storage.setItem(`t3code:sidebar-hidden-threads:v2:agreed:${profile}`, "[]");
    }
  };
  return { storage, open, broadcast, hydrate };
}

const hidden = (
  window: Awaited<ReturnType<typeof openWindow>>,
  environmentId: string,
  id: string,
  createdAt?: string,
) =>
  isSidebarHiddenThread(window.module.useSidebarHiddenThreads.getState().marks, {
    environmentId,
    id,
    ...(createdAt ? { createdAt } : {}),
  });

function liveShell(environmentId: string, threads: Array<[string, string]>) {
  const value = {
    status: "live",
    snapshot: Option.some({
      threads: threads.map(([id, createdAt]) => ({
        id,
        createdAt: DateTime.makeUnsafe(createdAt),
      })),
    }),
  };
  fixture.shells.set(environmentId, value);
  for (const listener of fixture.shellListeners.get(environmentId) ?? []) listener(value);
}

/** A Gateway profile with only the hidden-threads section, which checks versions. */
function fakeGateway(initial: string[] = []) {
  const gateway = {
    version: initial.length > 0 ? 1 : 0,
    value:
      initial.length > 0
        ? {
            schema: 1,
            threads: initial.map((key) => {
              const [environmentId, threadId] = key.split(":");
              return { environmentId, threadId };
            }),
          }
        : null,
    patches: [] as Record<string, OrbitGatewaySectionPatch>[],
    beforeSettings: null as Promise<void> | null,
    beforePatch: null as Promise<void> | null,
    onPatch: null as (() => void) | null,
  };
  const read = (): OrbitGatewaySettings => ({
    profileId: 1,
    version: gateway.version,
    workspaces: [],
    updatedAt: "",
    document: gateway.value ? { sidebarHiddenThreads: gateway.value } : {},
    sections: {
      sidebarHiddenThreads: { version: gateway.version, updatedAt: null, updatedBy: "" },
    },
  });
  const client = {
    settings: async () => {
      await gateway.beforeSettings;
      return read();
    },
    patchSections: async (_id: number, patch: Record<string, OrbitGatewaySectionPatch>) => {
      gateway.patches.push(patch);
      gateway.onPatch?.();
      await gateway.beforePatch;
      const section = patch.sidebarHiddenThreads!;
      if (section.version !== gateway.version) {
        throw new OrbitGatewayError({
          code: "conn.settings_version_conflict",
          message: "stale",
          status: 409,
          details: {},
        });
      }
      gateway.version += 1;
      gateway.value = section.value as typeof gateway.value;
      return read();
    },
  };
  const me = (): OrbitGatewayNode =>
    ({ profile: { id: 1, name: "Nick", settingsVersion: gateway.version } }) as OrbitGatewayNode;
  return { gateway, client, me };
}

/** What the main window's profile sync does for this section. */
function mainSync(
  window: Awaited<ReturnType<typeof openWindow>>,
  fake: ReturnType<typeof fakeGateway>,
) {
  let state: ProfileSyncState | null = null;
  const engine = createProfileSync({
    client: fake.client,
    channels: () => [window.module.sidebarHiddenThreadsChannel(1)],
    loadState: () => state,
    saveState: (next) => {
      state = next;
    },
  });
  return () => {
    window.module.bindSidebarHiddenProfile(1);
    return engine.run(fake.me());
  };
}

describe("sidebar hidden threads store", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("keeps a fresh client's Orbit rows out until its profile's marks arrive", async () => {
    const { open } = setup();
    const main = await open();
    const fake = fakeGateway(["clone:hidden"]);
    let release!: () => void;
    fake.gateway.beforeSettings = new Promise((resolve) => (release = resolve));
    // First paint, nothing bound: the Orbit environment waits, the local one is usable.
    expect(hidden(main, "clone", "hidden")).toBe(true);
    expect(hidden(main, "clone", "visible")).toBe(true);
    expect(hidden(main, "local", "mine")).toBe(false);

    const run = mainSync(main, fake)();
    // Bound, but the profile's section has not been read yet.
    expect(hidden(main, "clone", "visible")).toBe(true);
    release();
    await run;
    expect(hidden(main, "clone", "hidden")).toBe(true);
    expect(hidden(main, "clone", "visible")).toBe(false);
    expect(fake.gateway.patches).toHaveLength(0);
  });

  it("keeps two windows' Disconnects, and an edit made while the write is in flight", async () => {
    const { open, broadcast } = setup();
    const main = await open();
    const extra = await open();
    const fake = fakeGateway();
    const sync = mainSync(main, fake);
    await sync();
    broadcast(main);

    main.module.hideSidebarThread({ environmentId: "clone", threadId: "x" });
    extra.module.hideSidebarThread({ environmentId: "clone", threadId: "y" });
    broadcast(extra);
    let release!: () => void;
    fake.gateway.beforePatch = new Promise((resolve) => (release = resolve));
    const patched = new Promise<void>((resolve) => (fake.gateway.onPatch = resolve));
    const run = sync();
    await patched;
    // The user shows x again while the write that hides it is in flight.
    extra.module.showSidebarThread({ environmentId: "clone", threadId: "x" });
    release();
    await run;
    expect(fake.gateway.value?.threads).toEqual([
      { environmentId: "clone", threadId: "x" },
      { environmentId: "clone", threadId: "y" },
    ]);
    broadcast(main);
    expect(hidden(main, "clone", "x")).toBe(false);
    expect(hidden(extra, "clone", "y")).toBe(true);
    fake.gateway.beforePatch = null;
    await sync();
    expect(fake.gateway.value?.threads).toEqual([{ environmentId: "clone", threadId: "y" }]);
  });

  it("lets an extra window follow the main window's profile, without writing it back", async () => {
    const { open, broadcast, storage } = setup();
    const main = await open();
    const extra = await open();
    main.module.bindSidebarHiddenProfile(1);
    broadcast(main);
    main.module.bindSidebarHiddenProfile(2);
    broadcast(main);
    extra.module.hideSidebarThread({ environmentId: "clone", threadId: "x" });
    expect(extra.module.useSidebarHiddenThreads.getState().active).toBe("2");
    expect(storage.getItem("t3code:sidebar-hidden-threads:v2:active")).toBe('"2"');
    expect(storage.getItem("t3code:sidebar-hidden-threads:v2:op:2:clone:x")).not.toBeNull();
    // Orbit mode off: every window unbinds and the profile's marks no longer apply.
    main.module.bindSidebarHiddenProfile(null);
    broadcast(main);
    expect(hidden(extra, "clone", "x")).toBe(false);
  });

  it("carries a peek made before the first bind to that profile", async () => {
    const { open, hydrate } = setup();
    hydrate(1);
    const main = await open();
    const peek = main.module.beginSidebarPeek(
      { environmentId: "clone", threadId: "target" },
      { targetListed: false, environmentSurfaced: false },
    );
    main.module.bindSidebarHiddenProfile(1);
    expect(hidden(main, "clone", "target")).toBe(true);
    peek.commit();
    expect(main.module.useSidebarHiddenThreads.getState().marks.keys.has("clone:target")).toBe(
      true,
    );
  });

  it("keeps a sibling shown during a hold out of the sweep, also after the show is acknowledged", async () => {
    const { open } = setup();
    const main = await open();
    const fake = fakeGateway();
    const sync = mainSync(main, fake);
    await sync();
    const peek = main.module.beginSidebarPeek(
      { environmentId: "clone", threadId: "target" },
      { targetListed: false, environmentSurfaced: true },
    );
    peek.commit();
    main.module.showSidebarThread({ environmentId: "clone", threadId: "sibling" });
    await sync();
    liveShell("clone", [
      ["target", "2026-11-01T00:00:00.000Z"],
      ["sibling", "2026-11-02T00:00:00.000Z"],
      ["other", "2026-11-03T00:00:00.000Z"],
    ]);
    expect(hidden(main, "clone", "target")).toBe(true);
    expect(hidden(main, "clone", "sibling")).toBe(false);
    expect(hidden(main, "clone", "other")).toBe(true);
    // An older settled thread that pages in later is part of the inventory the peek found.
    expect(hidden(main, "clone", "older", "2026-10-01T00:00:00.000Z")).toBe(true);
    expect(hidden(main, "clone", "created-later", "2026-11-04T00:00:00.000Z")).toBe(false);
    await sync();
    expect(fake.gateway.value?.threads).toEqual([
      { environmentId: "clone", threadId: "target" },
      { environmentId: "clone", threadId: "other" },
    ]);
  });

  it("cancels only its own peek, and drops a peek whose profile was left", async () => {
    const { open, hydrate } = setup();
    hydrate(1, 2);
    const main = await open();
    main.module.bindSidebarHiddenProfile(1);
    const first = main.module.beginSidebarPeek(
      { environmentId: "clone", threadId: "a" },
      { targetListed: false, environmentSurfaced: true },
    );
    const second = main.module.beginSidebarPeek(
      { environmentId: "clone", threadId: "b" },
      { targetListed: false, environmentSurfaced: true },
    );
    first.cancel();
    expect(hidden(main, "clone", "a")).toBe(true);
    expect(hidden(main, "clone", "unrelated")).toBe(true);
    main.module.bindSidebarHiddenProfile(2);
    second.commit();
    main.module.bindSidebarHiddenProfile(1);
    expect(main.module.useSidebarHiddenThreads.getState().marks.keys.size).toBe(0);
    expect(hidden(main, "clone", "unrelated")).toBe(false);
  });

  it("peeks at a loaded thread the scoped sidebar does not list", async () => {
    const { open, hydrate } = setup();
    hydrate(1);
    const main = await open();
    main.module.bindSidebarHiddenProfile(1);
    main.module.publishSidebarListedThreads(new Set(["clone:in-scope"]));
    expect(main.module.isSidebarListedNow("clone", "in-scope")).toBe(true);
    expect(main.module.isSidebarListedNow("clone", "other-project")).toBe(false);
    const peek = main.module.beginSidebarPeek(
      { environmentId: "clone", threadId: "other-project" },
      {
        targetListed: main.module.isSidebarListedNow("clone", "other-project"),
        environmentSurfaced: false,
      },
    );
    peek.commit();
    expect(hidden(main, "clone", "other-project")).toBe(true);
    expect(hidden(main, "clone", "in-scope")).toBe(false);
  });
});
