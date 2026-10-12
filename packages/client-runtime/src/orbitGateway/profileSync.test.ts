// @effect-diagnostics globalTimers:off - The profile sync runs on plain promises, outside an Effect runtime.
import { describe, expect, it } from "vite-plus/test";

import {
  OrbitGatewayError,
  type OrbitGatewayNode,
  type OrbitGatewaySectionPatch,
  type OrbitGatewaySettings,
} from "./client.ts";
import type { JsonObject, ProfileSectionName } from "./profileDocument.ts";
import {
  createProfileSync,
  withoutSection,
  type ProfileSyncChannel,
  type ProfileSyncState,
} from "./profileSync.ts";
import { jsonEqual, mergeAppearance, mergeDeviceSection, toGatewayForm } from "./sectionMerge.ts";

type Values = Record<string, string | number | boolean>;
const device = (values: Values, schema = 1): JsonObject => ({ schema, values: { ...values } });
const valuesOf = (section: JsonObject | null | undefined): Values =>
  ((section?.values as Values | undefined) ?? {}) as Values;

/** What the real Gateway does to a section: refuses empty maps, trims strings, stores "" as null. */
function storedLikeTheGateway(value: unknown): unknown {
  if (typeof value === "string") return value.trim() === "" ? null : value.trim();
  if (Array.isArray(value)) return value.map(storedLikeTheGateway);
  if (typeof value === "object" && value !== null) {
    if (Object.keys(value).length === 0) {
      throw new OrbitGatewayError("validation.failed", "empty map", 422);
    }
    return Object.fromEntries(
      Object.entries(value).map(([key, entry]) => [key, storedLikeTheGateway(entry)]),
    );
  }
  return value;
}

/** An in-memory Gateway that checks section versions the way the real one is specified to. */
function fakeGateway(options: { sections?: boolean } = {}) {
  const gateway = {
    version: 1,
    supportsSections: options.sections ?? true,
    patchStatus: null as number | null,
    alwaysConflict: false,
    sections: new Map<string, { version: number; value: JsonObject; updatedBy: string }>(),
    gets: 0,
    patches: [] as Record<string, OrbitGatewaySectionPatch>[],
    caller: "mac",
  };
  const settings = (): OrbitGatewaySettings => {
    const document: Record<string, unknown> = { workspaces: [] };
    const devices: Record<string, unknown> = {};
    const meta: Record<string, { version: number; updatedAt: string | null; updatedBy: string }> =
      {};
    for (const [name, entry] of gateway.sections) {
      if (name === "appearance") document.appearance = entry.value;
      else devices[name.slice("devices.".length)] = entry.value;
      meta[name] = { version: entry.version, updatedAt: "now", updatedBy: entry.updatedBy };
    }
    if (Object.keys(devices).length > 0) document.devices = devices;
    return {
      profileId: 1,
      version: gateway.version,
      workspaces: [],
      updatedAt: "",
      document,
      sections: gateway.supportsSections ? meta : null,
    };
  };
  const client = {
    settings: async () => {
      gateway.gets += 1;
      return settings();
    },
    patchSections: async (_id: number, patch: Record<string, OrbitGatewaySectionPatch>) => {
      gateway.patches.push(patch);
      if (gateway.patchStatus !== null) {
        throw new OrbitGatewayError("gateway.request_failed", "no", gateway.patchStatus);
      }
      for (const section of Object.values(patch)) storedLikeTheGateway(section.value);
      const stale = Object.entries(patch).filter(
        ([name, section]) =>
          gateway.alwaysConflict || (gateway.sections.get(name)?.version ?? 0) !== section.version,
      );
      if (stale.length > 0) {
        throw new OrbitGatewayError("conn.settings_version_conflict", "stale", 409, {
          current_version: gateway.version,
        });
      }
      for (const [name, section] of Object.entries(patch)) {
        const current = gateway.sections.get(name);
        if (section.value === null) gateway.sections.delete(name);
        else {
          gateway.sections.set(name, {
            version: (current?.version ?? 0) + 1,
            value: storedLikeTheGateway(section.value) as JsonObject,
            updatedBy: gateway.caller,
          });
        }
      }
      gateway.version += 1;
      return settings();
    },
  };
  const me = (): OrbitGatewayNode => ({
    id: 8,
    name: gateway.caller,
    wireguardIp: "10.44.0.6",
    profile: { id: 1, name: "Nick", settingsVersion: gateway.version, updatedAt: "" },
  });
  return { gateway, client, me };
}

/** One device with a desktop-settings channel and an appearance channel kept in memory. */
function makeDevice(
  fake: ReturnType<typeof fakeGateway>,
  initial: { settings?: Values; appearance?: JsonObject | null } = {},
  extra: { enabled?: (name: ProfileSectionName) => boolean; now?: () => number } = {},
) {
  const memory = {
    settings: { ...(initial.settings ?? { font: "Inter", size: 15 }) } as Values,
    appearance: (initial.appearance ?? { schema: 1, mode: "system", contrast: 100 }) as JsonObject,
    state: null as ProfileSyncState | null,
    backups: [] as { name: string; value: JsonObject }[],
    writes: [] as string[],
  };
  const channels: ProfileSyncChannel[] = [
    {
      name: "devices.desktop",
      readLocal: () => device(memory.settings),
      applyRemote: (value) => {
        // Applying keeps only the keys this build knows, like the real allowlist.
        const known = valuesOf(value);
        memory.settings = {
          font: String(known.font ?? memory.settings.font),
          size: Number(known.size ?? memory.settings.size),
        };
        memory.writes.push("devices.desktop");
      },
      merge: mergeDeviceSection,
    },
    {
      name: "appearance",
      readLocal: () => ({ ...memory.appearance }),
      applyRemote: (value) => {
        memory.appearance = {
          schema: 1,
          mode: value.mode ?? "system",
          contrast: value.contrast ?? 100,
        };
        memory.writes.push("appearance");
      },
      merge: mergeAppearance,
    },
  ];
  const engine = createProfileSync({
    client: fake.client,
    channels: () => channels,
    loadState: () => memory.state,
    saveState: (state) => {
      memory.state = state;
    },
    onAdopt: (name, value) => memory.backups.push({ name, value }),
    ...(extra.enabled ? { isEnabled: extra.enabled } : {}),
    ...(extra.now ? { now: extra.now } : {}),
  });
  const sync = async (options?: Parameters<typeof engine.run>[1]) => {
    fake.gateway.caller = "device";
    return engine.run(fake.me(), options);
  };
  return { memory, engine, sync };
}

describe("profile sync engine", () => {
  it("seeds an empty profile from the first device and lets a second device adopt it", async () => {
    const fake = fakeGateway();
    const mac = makeDevice(fake, { settings: { font: "Inter", size: 15 } });
    const first = await mac.sync();
    expect(first).toMatchObject({
      kind: "synced",
      outcomes: { "devices.desktop": "seeded", appearance: "seeded" },
    });
    expect(fake.gateway.patches).toHaveLength(1);
    expect(Object.keys(fake.gateway.patches[0]!).sort()).toEqual(["appearance", "devices.desktop"]);

    const other = makeDevice(fake, { settings: { font: "Menlo", size: 12 } });
    const second = await other.sync();
    expect(second).toMatchObject({
      kind: "synced",
      outcomes: { "devices.desktop": "adopted", appearance: "adopted" },
    });
    expect(other.memory.settings).toEqual({ font: "Inter", size: 15 });
    // The profile wins, and what the device had is kept for "Restore previous settings".
    expect(other.memory.backups).toContainEqual({
      name: "devices.desktop",
      value: device({ font: "Menlo", size: 12 }),
    });
    expect(fake.gateway.patches).toHaveLength(1);
  });

  it("adopts without a backup when the device already matches the profile", async () => {
    const fake = fakeGateway();
    await makeDevice(fake).sync();
    const twin = makeDevice(fake);
    await twin.sync();
    expect(twin.memory.backups).toEqual([]);
  });

  it("sends nothing after a pull and reads nothing while the profile is unchanged", async () => {
    const fake = fakeGateway();
    const mac = makeDevice(fake, { settings: { font: "Inter", size: 15 } });
    await mac.sync();
    const other = makeDevice(fake, { settings: { font: "Inter", size: 15 } });
    await other.sync();

    mac.memory.settings.size = 18;
    await mac.sync();
    expect(fake.gateway.patches).toHaveLength(2);

    const patchesBefore = fake.gateway.patches.length;
    const pulled = await other.sync();
    expect(pulled).toMatchObject({ outcomes: { "devices.desktop": "pulled" } });
    expect(other.memory.settings.size).toBe(18);
    // The write that applied the profile's value is not an edit: no echo, however often it runs.
    await other.sync();
    await other.sync();
    expect(fake.gateway.patches).toHaveLength(patchesBefore);

    const getsBefore = fake.gateway.gets;
    await other.sync();
    expect(fake.gateway.gets).toBe(getsBefore);
  });

  it("does not echo when the device normalises what it was given", async () => {
    const fake = fakeGateway();
    const mac = makeDevice(fake);
    await mac.sync();
    // Another build wrote a value this one rounds on apply.
    fake.gateway.sections.set("appearance", {
      version: 5,
      value: { schema: 1, mode: "dark", contrast: 120, futureKey: true },
      updatedBy: "phone",
    });
    fake.gateway.version += 1;
    await mac.sync();
    const patches = fake.gateway.patches.length;
    await mac.sync();
    await mac.sync();
    expect(fake.gateway.patches).toHaveLength(patches);
  });

  it("converges two devices that edit different keys at the same time", async () => {
    const fake = fakeGateway();
    const mac = makeDevice(fake, { settings: { font: "Inter", size: 15 } });
    const mini = makeDevice(fake, { settings: { font: "Inter", size: 15 } });
    await mac.sync();
    await mini.sync();

    mac.memory.settings.font = "Menlo";
    mini.memory.settings.size = 20;
    await mac.sync();
    // The mini holds a stale version: its PATCH conflicts, merges and succeeds.
    const result = await mini.sync();
    expect(result).toMatchObject({ outcomes: { "devices.desktop": "merged" } });
    expect(mini.memory.settings).toEqual({ font: "Menlo", size: 20 });

    await mac.sync();
    expect(mac.memory.settings).toEqual({ font: "Menlo", size: 20 });
    const patches = fake.gateway.patches.length;
    await mac.sync();
    await mini.sync();
    expect(fake.gateway.patches).toHaveLength(patches);
  });

  it("lets the device in front of the user win when both edit the same key", async () => {
    const fake = fakeGateway();
    const mac = makeDevice(fake, { settings: { font: "Inter", size: 15 } });
    const mini = makeDevice(fake, { settings: { font: "Inter", size: 15 } });
    await mac.sync();
    await mini.sync();
    mac.memory.settings.size = 16;
    mini.memory.settings.size = 22;
    await mac.sync();
    await mini.sync();
    await mac.sync();
    expect(mini.memory.settings.size).toBe(22);
    expect(mac.memory.settings.size).toBe(22);
  });

  it("keeps keys it does not know when it sends a change", async () => {
    const fake = fakeGateway();
    const mac = makeDevice(fake);
    await mac.sync();
    fake.gateway.sections.set("devices.desktop", {
      version: 2,
      value: device({ font: "Inter", size: 15, futureSetting: "keep me" }),
      updatedBy: "newer-build",
    });
    fake.gateway.version += 1;
    await mac.sync();

    mac.memory.settings.size = 17;
    await mac.sync();
    expect(valuesOf(fake.gateway.sections.get("devices.desktop")!.value)).toEqual({
      font: "Inter",
      size: 17,
      futureSetting: "keep me",
    });
  });

  it("leaves a section written by a newer schema untouched", async () => {
    const fake = fakeGateway();
    const mac = makeDevice(fake);
    await mac.sync();
    fake.gateway.sections.set("devices.desktop", {
      version: 2,
      value: device({ font: "Inter", size: 15, newShape: 1 }, 2),
      updatedBy: "newer-build",
    });
    fake.gateway.version += 1;
    mac.memory.settings.size = 30;
    const before = fake.gateway.patches.length;
    await mac.sync();
    expect(fake.gateway.patches).toHaveLength(before);
    expect(fake.gateway.sections.get("devices.desktop")!.value.schema).toBe(2);
  });

  it("skips a section the user opted out of, and re-adopts the profile when it is turned back on", async () => {
    const fake = fakeGateway();
    const mac = makeDevice(fake, { settings: { font: "Inter", size: 15 } });
    await mac.sync();

    let appearanceOn = false;
    const mini = makeDevice(
      fake,
      { settings: { font: "Inter", size: 15 } },
      { enabled: (name) => name !== "appearance" || appearanceOn },
    );
    await mini.sync();
    expect(mini.memory.state?.sections.appearance).toBeUndefined();
    expect(mini.memory.writes).not.toContain("appearance");

    mini.memory.appearance = { schema: 1, mode: "dark", contrast: 100 };
    await mini.sync();
    expect(fake.gateway.sections.get("appearance")!.value.mode).toBe("system");

    appearanceOn = true;
    await mini.sync();
    // First sync again: the profile wins and the device's own value is kept as a backup.
    expect(mini.memory.appearance.mode).toBe("system");
    expect(mini.memory.backups.at(-1)).toEqual({
      name: "appearance",
      value: { schema: 1, mode: "dark", contrast: 100 },
    });
  });

  it("forgets a section so it syncs from scratch", async () => {
    const fake = fakeGateway();
    const mac = makeDevice(fake);
    await mac.sync();
    const state = withoutSection(mac.memory.state!, "appearance");
    expect(state.sections.appearance).toBeUndefined();
    expect(state.sections["devices.desktop"]).toBeDefined();
  });

  it("leaves everything alone on a Gateway without sections", async () => {
    const fake = fakeGateway({ sections: false });
    const mac = makeDevice(fake);
    expect(await mac.sync()).toEqual({ kind: "unsupported" });
    expect(fake.gateway.patches).toHaveLength(0);
  });

  it("treats a PATCH the Gateway does not know as unsupported, and probes again later", async () => {
    const fake = fakeGateway();
    fake.gateway.patchStatus = 404;
    let clock = 1_000;
    const mac = makeDevice(fake, {}, { now: () => clock });
    expect(await mac.sync()).toEqual({ kind: "unsupported" });
    expect(fake.gateway.patches).toHaveLength(1);

    expect(await mac.sync()).toEqual({ kind: "unsupported" });
    expect(fake.gateway.patches).toHaveLength(1);

    clock += 11 * 60_000;
    fake.gateway.patchStatus = null;
    expect(await mac.sync()).toMatchObject({ kind: "synced" });
    expect(fake.gateway.sections.has("appearance")).toBe(true);
  });

  it("gives up after three conflicting attempts", async () => {
    const fake = fakeGateway();
    const mac = makeDevice(fake);
    await mac.sync();
    mac.memory.settings.size = 99;
    fake.gateway.alwaysConflict = true;
    const before = fake.gateway.patches.length;
    await expect(mac.sync()).rejects.toMatchObject({ code: "conn.settings_version_conflict" });
    expect(fake.gateway.patches.length - before).toBe(3);
  });

  it("does not resend a value the Gateway refused until the device changes it", async () => {
    const fake = fakeGateway();
    const mac = makeDevice(fake);
    await mac.sync();
    mac.memory.settings.size = 99;
    fake.gateway.patchStatus = 422;
    await expect(mac.sync()).rejects.toMatchObject({ status: 422 });
    const attempts = fake.gateway.patches.length;
    await mac.sync();
    expect(fake.gateway.patches).toHaveLength(attempts);
    fake.gateway.patchStatus = null;
    mac.memory.settings.size = 98;
    await mac.sync();
    expect(fake.gateway.patches).toHaveLength(attempts + 1);
  });

  it("keeps an edit made while the PATCH was in flight for the next run", async () => {
    const fake = fakeGateway();
    const mac = makeDevice(fake);
    await mac.sync();
    mac.memory.settings.size = 40;
    const patch = fake.client.patchSections;
    fake.client.patchSections = async (id, sections) => {
      mac.memory.settings.size = 41;
      return patch(id, sections);
    };
    await mac.sync();
    expect(mac.memory.settings.size).toBe(41);
    await mac.sync();
    expect(valuesOf(fake.gateway.sections.get("devices.desktop")!.value).size).toBe(41);
  });

  it("forces a push or a pull of chosen sections", async () => {
    const fake = fakeGateway();
    const mac = makeDevice(fake, { settings: { font: "Inter", size: 15 } });
    const mini = makeDevice(fake, { settings: { font: "Inter", size: 15 } });
    await mac.sync();
    await mini.sync();
    mac.memory.settings.size = 18;
    await mac.sync();

    // The mini has not pulled yet; "use the profile's settings" does so for one section.
    await mini.sync({ force: { pull: ["devices.desktop"] } });
    expect(mini.memory.settings.size).toBe(18);

    mini.memory.settings.size = 25;
    await mini.sync({ force: { push: ["devices.desktop"] } });
    expect(valuesOf(fake.gateway.sections.get("devices.desktop")!.value).size).toBe(25);
  });

  it("returns who changed what when it read the profile", async () => {
    const fake = fakeGateway();
    const mac = makeDevice(fake);
    const result = await mac.sync();
    expect(result).toMatchObject({
      kind: "synced",
      sections: { appearance: { updatedBy: "device" } },
    });
  });
});

describe("overlapping runs", () => {
  it("sends one PATCH when two runs start back to back", async () => {
    const fake = fakeGateway();
    const mac = makeDevice(fake, { settings: { font: "Inter", size: 15 } });
    fake.gateway.caller = "device";
    const me = fake.me();
    // Both triggers fire before either run has read the profile, as when an effect mounts twice.
    const [first, second] = await Promise.all([mac.engine.run(me), mac.engine.run(me)]);
    expect(fake.gateway.patches).toHaveLength(1);
    expect(Object.keys(fake.gateway.patches[0]!).sort()).toEqual(["appearance", "devices.desktop"]);
    expect(first).toMatchObject({ outcomes: { "devices.desktop": "seeded" } });
    // The second run waited, found nothing dirty and sent nothing; it did not meet a 409.
    expect(second).toMatchObject({ kind: "synced", outcomes: {} });
  });

  it("runs one at a time even when a run is slow", async () => {
    const fake = fakeGateway();
    const mac = makeDevice(fake);
    let inFlight = 0;
    let overlapped = false;
    const settings = fake.client.settings;
    fake.client.settings = async () => {
      inFlight += 1;
      overlapped ||= inFlight > 1;
      await new Promise((resolve) => setTimeout(resolve, 5));
      try {
        return await settings();
      } finally {
        inFlight -= 1;
      }
    };
    const me = fake.me();
    await Promise.all([mac.engine.run(me), mac.engine.run(me), mac.engine.run(me)]);
    expect(overlapped).toBe(false);
    expect(fake.gateway.patches).toHaveLength(1);
  });
});

describe("what the Gateway does to a section", () => {
  it("never sends an empty map, and still syncs the rest of the section", async () => {
    const fake = fakeGateway();
    const mac = makeDevice(fake, {
      appearance: {
        schema: 1,
        mode: "dark",
        contrast: 100,
        themes: {},
        variants: { light: {}, dark: {} },
        customThemes: [{ id: "a", colors: {} }],
      } as JsonObject,
    });
    await expect(mac.sync()).resolves.toMatchObject({ kind: "synced" });
    expect(fake.gateway.sections.get("appearance")!.value).toEqual({
      schema: 1,
      mode: "dark",
      contrast: 100,
      customThemes: [{ id: "a" }],
    });
  });

  it("does not push again when the Gateway trimmed a string or turned an empty one into null", async () => {
    const fake = fakeGateway();
    const mac = makeDevice(fake, { settings: { font: "", size: 15 } });
    await mac.sync();
    expect(valuesOf(fake.gateway.sections.get("devices.desktop")!.value).font).toBeNull();

    mac.memory.settings.font = "  Inter  ";
    await mac.sync();
    expect(valuesOf(fake.gateway.sections.get("devices.desktop")!.value).font).toBe("Inter");

    const patches = fake.gateway.patches.length;
    await mac.sync();
    await mac.sync();
    expect(fake.gateway.patches).toHaveLength(patches);
  });

  it("does not read its own normalized write as another device's edit", async () => {
    const fake = fakeGateway();
    const mac = makeDevice(fake, { settings: { font: "", size: 15 } });
    const mini = makeDevice(fake, { settings: { font: "", size: 15 } });
    await mac.sync();
    await mini.sync();
    mac.memory.settings.size = 18;
    mini.memory.settings.font = " ";
    await mac.sync();
    // The mini's edit is blank, which the Gateway stores as null: same as what is there.
    const result = await mini.sync();
    expect(result).toMatchObject({ kind: "synced" });
    expect(mini.memory.settings.size).toBe(18);
    const patches = fake.gateway.patches.length;
    await mini.sync();
    await mac.sync();
    expect(fake.gateway.patches).toHaveLength(patches);
  });

  it("puts values in the Gateway's form", () => {
    expect(
      toGatewayForm({
        a: "  x ",
        b: "   ",
        c: { d: {}, e: [] },
        f: [{}, "", { g: 1 }],
        h: {},
        i: 0,
        j: false,
      }),
    ).toEqual({ a: "x", b: null, c: { e: [] }, f: [null, { g: 1 }], j: false, i: 0 });
  });
});

describe("non-user changes", () => {
  it("does not push a server-pushed default and does not seed the profile with it", async () => {
    const fake = fakeGateway();
    const mac = makeDevice(fake);
    const finish = mac.engine.beginNonUserChange("appearance");
    mac.memory.appearance = { schema: 1, mode: "dark", contrast: 100, theme: "server-default" };
    finish();

    await mac.sync();
    expect(fake.gateway.sections.has("appearance")).toBe(false);
    expect(fake.gateway.sections.has("devices.desktop")).toBe(true);
    const patches = fake.gateway.patches.length;
    await mac.sync();
    expect(fake.gateway.patches).toHaveLength(patches);
  });

  it("pushes the user's own pick that comes after a default", async () => {
    const fake = fakeGateway();
    const mac = makeDevice(fake);
    await mac.sync();
    const finish = mac.engine.beginNonUserChange("appearance");
    mac.memory.appearance = { schema: 1, mode: "dark", contrast: 100 };
    finish();
    await mac.sync();
    expect(fake.gateway.sections.get("appearance")!.value.mode).toBe("system");

    mac.memory.appearance = { schema: 1, mode: "light", contrast: 100 };
    await mac.sync();
    expect(fake.gateway.sections.get("appearance")!.value.mode).toBe("light");
  });

  it("lets the profile replace a default that was not the user's", async () => {
    const fake = fakeGateway();
    const mac = makeDevice(fake);
    const phone = makeDevice(fake);
    await mac.sync();
    await phone.sync();
    const finish = mac.engine.beginNonUserChange("appearance");
    mac.memory.appearance = { schema: 1, mode: "dark", contrast: 100 };
    finish();

    phone.memory.appearance = { schema: 1, mode: "light", contrast: 100 };
    await phone.sync();
    await mac.sync();
    expect(mac.memory.appearance.mode).toBe("light");
  });

  it("does not hide unsent user edits behind a later default", async () => {
    const fake = fakeGateway();
    const mac = makeDevice(fake);
    await mac.sync();
    mac.memory.appearance = { schema: 1, mode: "light", contrast: 100 };
    const finish = mac.engine.beginNonUserChange("appearance");
    mac.memory.appearance = { schema: 1, mode: "light", contrast: 130 };
    finish();
    await mac.sync();
    expect(fake.gateway.sections.get("appearance")!.value).toMatchObject({
      mode: "light",
      contrast: 130,
    });
  });
});

describe("section merge", () => {
  const appearance = (overrides: Record<string, unknown> = {}): JsonObject =>
    ({
      schema: 1,
      mode: "system",
      contrast: 100,
      themes: {
        light: { id: "t3-code", source: "stock" },
        dark: { id: "ocean", source: "builtin" },
      },
      customThemes: [],
      ...overrides,
    }) as JsonObject;
  const custom = (id: string, name = id): JsonObject => ({
    id,
    name,
    appearance: "dark",
    colors: { canvas: "#000" },
  });

  it("merges mode, contrast and each slot on their own", () => {
    const base = appearance();
    const local = appearance({ mode: "dark" });
    const remote = appearance({
      contrast: 120,
      themes: {
        light: { id: "grove", source: "builtin" },
        dark: { id: "ocean", source: "builtin" },
      },
    });
    expect(mergeAppearance(base, local, remote)).toEqual(
      appearance({
        mode: "dark",
        contrast: 120,
        themes: {
          light: { id: "grove", source: "builtin" },
          dark: { id: "ocean", source: "builtin" },
        },
      }),
    );
  });

  it("merges the custom theme library by id and lets an edit beat a delete", () => {
    const base = appearance({ customThemes: [custom("a"), custom("b")] });
    const local = appearance({ customThemes: [custom("a", "A local"), custom("b"), custom("c")] });
    const remote = appearance({ customThemes: [custom("a"), custom("b", "B edited")] });
    const merged = mergeAppearance(base, local, remote).customThemes as JsonObject[];
    expect(merged.map((theme) => `${theme.id}:${theme.name}`)).toEqual([
      "a:A local",
      "b:B edited",
      "c:c",
    ]);

    const deletedRemotely = appearance({ customThemes: [custom("b")] });
    const kept = mergeAppearance(
      base,
      appearance({ customThemes: [custom("a", "A local"), custom("b")] }),
      deletedRemotely,
    );
    expect((kept.customThemes as JsonObject[]).map((theme) => theme.id)).toEqual(["a", "b"]);
  });

  it("keeps unknown keys from the profile", () => {
    const merged = mergeAppearance(appearance(), appearance({ mode: "dark" }), {
      ...appearance(),
      accentBoost: 3,
      themes: { ...(appearance().themes as JsonObject), highContrast: { id: "x" } },
    });
    expect(merged.accentBoost).toBe(3);
    expect((merged.themes as JsonObject).highContrast).toEqual({ id: "x" });
    expect(merged.mode).toBe("dark");
  });

  it("compares JSON by content, not by key order", () => {
    expect(jsonEqual({ a: 1, b: [1, { c: 2 }] }, { b: [1, { c: 2 }], a: 1 })).toBe(true);
    expect(jsonEqual({ a: 1 }, { a: 1, b: 2 })).toBe(false);
  });
});
