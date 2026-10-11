// @effect-diagnostics nodeBuiltinImport:off globalDate:off -- Copies real folders in a temp directory.
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vite-plus/test";

import { resolveForkBrand } from "./forkBrand.ts";
import { UPSTREAM_APP_BRAND } from "./appBrand.ts";
import {
  MIGRATION_MARKER_FILE,
  copyPreviousUserData,
  readMigrationMarker,
  shapeLocalStorageEntries,
  shouldCopyUserDataEntry,
  writeLocalStorageScript,
  writeMigrationMarker,
} from "./AppRenameUserData.ts";

const brand = resolveForkBrand({});
const now = () => new Date("2026-10-10T10:00:00.000Z");

let appData: string;

beforeEach(() => {
  appData = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "conn-userdata-"));
});

afterEach(() => {
  NodeFS.rmSync(appData, { recursive: true, force: true });
});

const write = (path: string, contents: string) => {
  NodeFS.mkdirSync(NodePath.dirname(path), { recursive: true });
  NodeFS.writeFileSync(path, contents);
};

const seedOldFolder = (name: string) => {
  const root = NodePath.join(appData, name);
  write(NodePath.join(root, "Local Storage/leveldb/000003.log"), "workspaces");
  write(NodePath.join(root, "Partitions/t3code-preview-a/Cookies"), "cookies");
  write(NodePath.join(root, "Preferences"), "{}");
  write(NodePath.join(root, "Cache/Cache_Data/f_000001"), "cache");
  write(NodePath.join(root, "Partitions/t3code-preview-a/Cache/Cache_Data/f_000002"), "cache");
  write(NodePath.join(root, "SingletonCookie"), "123");
  write(NodePath.join(root, "DevToolsActivePort"), "9222");
  NodeFS.symlinkSync("host-1234", NodePath.join(root, "SingletonLock"));
  return root;
};

describe("copyPreviousUserData", () => {
  it("copies the old folder when the new one does not exist, and leaves the old one as it was", () => {
    const source = seedOldFolder("t3code-dev");

    const result = copyPreviousUserData({
      appDataDirectory: appData,
      brand,
      isDevelopment: true,
      now,
    });

    const target = NodePath.join(appData, "conn-dev");
    expect(result).toEqual({ status: "copied", source, target });
    expect(
      NodeFS.readFileSync(NodePath.join(target, "Local Storage/leveldb/000003.log"), "utf8"),
    ).toBe("workspaces");
    expect(
      NodeFS.readFileSync(NodePath.join(target, "Partitions/t3code-preview-a/Cookies"), "utf8"),
    ).toBe("cookies");
    expect(NodeFS.existsSync(`${target}.migrating`)).toBe(false);
    expect(
      NodeFS.readFileSync(NodePath.join(source, "Local Storage/leveldb/000003.log"), "utf8"),
    ).toBe("workspaces");
    expect(NodeFS.lstatSync(NodePath.join(source, "SingletonLock")).isSymbolicLink()).toBe(true);
    expect(readMigrationMarker(target)).toEqual({
      version: 1,
      status: "copied",
      from: source,
      copiedAt: "2026-10-10T10:00:00.000Z",
    });
  });

  it("leaves out caches and the files tied to the old app's process", () => {
    seedOldFolder("t3code");

    copyPreviousUserData({ appDataDirectory: appData, brand, isDevelopment: false, now });

    const target = NodePath.join(appData, "conn");
    expect(NodeFS.existsSync(NodePath.join(target, "Cache"))).toBe(false);
    expect(NodeFS.existsSync(NodePath.join(target, "Partitions/t3code-preview-a/Cache"))).toBe(
      false,
    );
    for (const name of ["SingletonLock", "SingletonCookie", "DevToolsActivePort"]) {
      expect(NodeFS.existsSync(NodePath.join(target, name))).toBe(false);
    }
    expect(NodeFS.existsSync(NodePath.join(target, "Preferences"))).toBe(true);
  });

  it("takes each channel from its own old folder", () => {
    seedOldFolder("t3code");
    write(NodePath.join(appData, "t3code-dev/Preferences"), "dev");

    copyPreviousUserData({ appDataDirectory: appData, brand, isDevelopment: true, now });

    expect(NodeFS.readFileSync(NodePath.join(appData, "conn-dev/Preferences"), "utf8")).toBe("dev");
    expect(NodeFS.existsSync(NodePath.join(appData, "conn"))).toBe(false);
  });

  it("prefers the display-name folder upstream uses over a stale scheme folder", () => {
    write(NodePath.join(appData, "t3code/Preferences"), "stale");
    const alpha = NodePath.join(appData, "T3 Code (Alpha)");
    write(NodePath.join(alpha, "Preferences"), "live");

    const result = copyPreviousUserData({
      appDataDirectory: appData,
      brand,
      isDevelopment: false,
      now,
    });

    expect(result).toEqual({
      status: "copied",
      source: alpha,
      target: NodePath.join(appData, "conn"),
    });
    expect(NodeFS.readFileSync(NodePath.join(appData, "conn/Preferences"), "utf8")).toBe("live");
  });

  it("copies the dev display-name folder, and does not take the packaged one for dev", () => {
    write(NodePath.join(appData, "T3 Code (Alpha)/Preferences"), "alpha");
    expect(
      copyPreviousUserData({ appDataDirectory: appData, brand, isDevelopment: true, now }),
    ).toEqual({ status: "not-needed" });

    write(NodePath.join(appData, "T3 Code (Dev)/Preferences"), "dev");
    copyPreviousUserData({ appDataDirectory: appData, brand, isDevelopment: true, now });

    expect(NodeFS.readFileSync(NodePath.join(appData, "conn-dev/Preferences"), "utf8")).toBe("dev");
    expect(NodeFS.existsSync(NodePath.join(appData, "conn"))).toBe(false);
  });

  it("falls back to the scheme folder when no display-name folder exists", () => {
    const source = seedOldFolder("t3code");
    expect(
      copyPreviousUserData({ appDataDirectory: appData, brand, isDevelopment: false, now }),
    ).toEqual({ status: "copied", source, target: NodePath.join(appData, "conn") });
  });

  it("copies once: an existing new folder is never touched", () => {
    seedOldFolder("t3code-dev");
    write(NodePath.join(appData, "conn-dev/Preferences"), "already here");

    const result = copyPreviousUserData({ appDataDirectory: appData, brand, isDevelopment: true });

    expect(result).toEqual({ status: "not-needed" });
    expect(NodeFS.readdirSync(NodePath.join(appData, "conn-dev"))).toEqual(["Preferences"]);
    expect(NodeFS.readFileSync(NodePath.join(appData, "conn-dev/Preferences"), "utf8")).toBe(
      "already here",
    );
  });

  it("does nothing without an old folder or for the upstream brand", () => {
    expect(copyPreviousUserData({ appDataDirectory: appData, brand, isDevelopment: true })).toEqual(
      { status: "not-needed" },
    );
    seedOldFolder("t3code-dev");
    expect(
      copyPreviousUserData({
        appDataDirectory: appData,
        brand: UPSTREAM_APP_BRAND,
        isDevelopment: true,
      }),
    ).toEqual({ status: "not-needed" });
    expect(NodeFS.existsSync(NodePath.join(appData, "conn-dev"))).toBe(false);
  });

  it("leaves no new folder behind when the copy fails, so the next launch tries again", () => {
    const source = seedOldFolder("t3code-dev");
    // An unreadable source makes the copy fail.
    NodeFS.chmodSync(source, 0o000);
    try {
      const result = copyPreviousUserData({
        appDataDirectory: appData,
        brand,
        isDevelopment: true,
      });
      expect(result.status).toBe("failed");
    } finally {
      NodeFS.chmodSync(source, 0o755);
    }
    expect(NodeFS.existsSync(NodePath.join(appData, "conn-dev"))).toBe(false);
    expect(NodeFS.existsSync(NodePath.join(appData, "conn-dev.migrating"))).toBe(false);

    const retry = copyPreviousUserData({ appDataDirectory: appData, brand, isDevelopment: true });
    expect(retry.status).toBe("copied");
  });

  it("clears a staging folder a crashed copy left behind", () => {
    seedOldFolder("t3code-dev");
    write(NodePath.join(appData, "conn-dev.migrating/leftover"), "partial");

    const result = copyPreviousUserData({ appDataDirectory: appData, brand, isDevelopment: true });

    expect(result.status).toBe("copied");
    expect(NodeFS.existsSync(NodePath.join(appData, "conn-dev/leftover"))).toBe(false);
  });
});

describe("migration marker", () => {
  it("round-trips and rejects anything else", () => {
    write(NodePath.join(appData, "x/keep"), "");
    const folder = NodePath.join(appData, "x");
    expect(readMigrationMarker(folder)).toBeNull();

    writeMigrationMarker(folder, {
      version: 1,
      status: "complete",
      from: "/old",
      copiedAt: "2026-10-10T10:00:00.000Z",
      completedAt: "2026-10-10T10:00:05.000Z",
      localStorageEntries: 12,
    });
    expect(readMigrationMarker(folder)?.status).toBe("complete");
    expect(readMigrationMarker(folder)?.localStorageEntries).toBe(12);

    NodeFS.writeFileSync(NodePath.join(folder, MIGRATION_MARKER_FILE), '{"version":2}');
    expect(readMigrationMarker(folder)).toBeNull();
    NodeFS.writeFileSync(NodePath.join(folder, MIGRATION_MARKER_FILE), "not json");
    expect(readMigrationMarker(folder)).toBeNull();
  });
});

describe("localStorage transfer", () => {
  it("keeps string entries only", () => {
    expect(
      shapeLocalStorageEntries({ "t3code:workspaces": "[]", broken: 1, nothing: null, list: [] }),
    ).toEqual({ "t3code:workspaces": "[]" });
    expect(shapeLocalStorageEntries(null)).toEqual({});
    expect(shapeLocalStorageEntries("text")).toEqual({});
  });

  it("writes entries through a script that keeps values the new origin already has", () => {
    const entries = {
      "t3code:environment-provider:v1": '"orbit"',
      "t3code:theme": 'a "quoted" value\nwith a line break and </script>',
    };
    const store = new Map<string, string>([["t3code:theme", "new origin's own"]]);
    const localStorage = {
      getItem: (key: string) => store.get(key) ?? null,
      setItem: (key: string, value: string) => void store.set(key, value),
    };

    const written = new Function("localStorage", `return ${writeLocalStorageScript(entries)}`)(
      localStorage,
    );

    expect(written).toBe(1);
    expect(store.get("t3code:environment-provider:v1")).toBe('"orbit"');
    expect(store.get("t3code:theme")).toBe("new origin's own");
  });

  it("copies values byte for byte", () => {
    const tricky = "line separator \u0000 😀 \\ ' \"";
    const store = new Map<string, string>();
    const localStorage = {
      getItem: (key: string) => store.get(key) ?? null,
      setItem: (key: string, value: string) => void store.set(key, value),
    };
    new Function("localStorage", `return ${writeLocalStorageScript({ key: tricky })}`)(
      localStorage,
    );
    expect(store.get("key")).toBe(tricky);
  });
});

describe("shouldCopyUserDataEntry", () => {
  it("skips the lock files and the caches by name", () => {
    expect(shouldCopyUserDataEntry("Cache")).toBe(false);
    expect(shouldCopyUserDataEntry("SingletonLock")).toBe(false);
    expect(shouldCopyUserDataEntry("Local Storage")).toBe(true);
    expect(shouldCopyUserDataEntry("IndexedDB")).toBe(true);
    expect(shouldCopyUserDataEntry("Partitions")).toBe(true);
  });
});
