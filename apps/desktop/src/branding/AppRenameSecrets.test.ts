// @effect-diagnostics nodeBuiltinImport:off -- Writes state files in a temp directory.
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vite-plus/test";

import {
  PRE_RENAME_BACKUP_SUFFIX,
  decryptChromiumV10,
  encryptChromiumV10,
  legacyKeychainServices,
  reencryptLegacySecrets,
} from "./AppRenameSecrets.ts";

// Chromium keeps a random password in the keychain; the strings here stand in for three of them.
const OLD_PASSWORD = "b0lmZ3NuYWtqZGZoYXNk";
const OTHER_OLD_PASSWORD = "c2Vjb25kLW9sZC1rZXktcGFzcw";
const NEW_PASSWORD = "bmV3LWtleS1mcm9tLXRoZS1uZXctYXBw";

/** What the new app's safeStorage does: reads and writes only values made with the new key. */
const newKey = {
  decryptCurrent: (bytes: Uint8Array) => decryptChromiumV10(bytes, NEW_PASSWORD),
  encryptCurrent: (plaintext: string) => encryptChromiumV10(plaintext, NEW_PASSWORD),
};

let stateDir: string;

beforeEach(() => {
  stateDir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "conn-secrets-"));
});

afterEach(() => {
  NodeFS.rmSync(stateDir, { recursive: true, force: true });
});

const b64 = (bytes: Uint8Array) => Buffer.from(bytes).toString("base64");
const writeJson = (name: string, value: unknown) =>
  NodeFS.writeFileSync(NodePath.join(stateDir, name), `${JSON.stringify(value)}\n`);
const readJson = (name: string) =>
  JSON.parse(NodeFS.readFileSync(NodePath.join(stateDir, name), "utf8")) as Record<string, unknown>;

describe("Chromium v10 values", () => {
  it("decrypts what it encrypted, and only with the same key", () => {
    const ciphertext = encryptChromiumV10('{"credentials":[{"token":"secret"}]}', OLD_PASSWORD);
    expect(ciphertext.subarray(0, 3).toString()).toBe("v10");
    expect(decryptChromiumV10(ciphertext, OLD_PASSWORD)).toBe(
      '{"credentials":[{"token":"secret"}]}',
    );
    expect(() => decryptChromiumV10(ciphertext, NEW_PASSWORD)).toThrow();
  });

  it("reads a value made by another implementation of Chromium's macOS scheme", () => {
    // Made without this module: Python's hashlib.pbkdf2_hmac('sha1', b'peanuts', b'saltysalt',
    // 1003, 16) gave the key d9a09d499b4e1b7461f28e67972c6dbd, and
    //   openssl enc -aes-128-cbc -K <key> -iv 20202020202020202020202020202020
    // encrypted {"hello":"world"} (the IV is 16 spaces). The "v10" prefix was added by hand.
    const fixture = Buffer.from("djEwfFFY1u5JwbB1GFNwp6WR5DdzzioyeehLmj/pX2J9mu8=", "base64");
    expect(decryptChromiumV10(fixture, "peanuts")).toBe('{"hello":"world"}');
    expect(encryptChromiumV10('{"hello":"world"}', "peanuts").equals(fixture)).toBe(true);
  });

  it("refuses data that is not v10", () => {
    expect(() => decryptChromiumV10(Buffer.from("v11abcdefghijklmnop"), OLD_PASSWORD)).toThrow(
      /v10/,
    );
  });

  it("lists the keychain items an earlier build used, most likely first", () => {
    expect(legacyKeychainServices(false)).toEqual([
      "t3code Safe Storage",
      "Electron Safe Storage",
      "T3 Code (Alpha) Safe Storage",
    ]);
    expect(legacyKeychainServices(true)[0]).toBe("Electron Safe Storage");
  });
});

describe("reencryptLegacySecrets", () => {
  it("moves the catalog and saved tokens that only an old key reads onto the new key", async () => {
    writeJson("connection-catalog.json", {
      version: 1,
      encryptedCatalog: b64(encryptChromiumV10('{"targets":[1]}', OTHER_OLD_PASSWORD)),
    });
    writeJson("saved-environments.json", {
      version: 1,
      records: [
        {
          environmentId: "a",
          encryptedBearerToken: b64(encryptChromiumV10("token-a", OLD_PASSWORD)),
        },
        { environmentId: "b" },
        {
          environmentId: "c",
          encryptedBearerToken: b64(encryptChromiumV10("token-c", NEW_PASSWORD)),
        },
      ],
    });
    const originalCatalog = NodeFS.readFileSync(
      NodePath.join(stateDir, "connection-catalog.json"),
      "utf8",
    );
    let passwordReads = 0;

    const result = await reencryptLegacySecrets({
      stateDir,
      ...newKey,
      legacyPasswords: async () => {
        passwordReads += 1;
        return [OLD_PASSWORD, OTHER_OLD_PASSWORD];
      },
    });

    expect(result).toEqual({ examined: 3, alreadyCurrent: 1, reencrypted: 2, failed: 0 });
    expect(passwordReads).toBe(1);
    const catalog = readJson("connection-catalog.json");
    expect(
      decryptChromiumV10(Buffer.from(catalog.encryptedCatalog as string, "base64"), NEW_PASSWORD),
    ).toBe('{"targets":[1]}');
    const records = readJson("saved-environments.json").records as Array<Record<string, string>>;
    expect(
      decryptChromiumV10(Buffer.from(records[0]!.encryptedBearerToken!, "base64"), NEW_PASSWORD),
    ).toBe("token-a");
    expect(records[1]).toEqual({ environmentId: "b" });
    // The original stays next to the rewritten file.
    expect(
      NodeFS.readFileSync(
        NodePath.join(stateDir, `connection-catalog.json${PRE_RENAME_BACKUP_SUFFIX}`),
        "utf8",
      ),
    ).toBe(originalCatalog);
  });

  it("does nothing, and never asks for an old key, when the new key reads everything", async () => {
    writeJson("connection-catalog.json", {
      version: 1,
      encryptedCatalog: b64(encryptChromiumV10("{}", NEW_PASSWORD)),
    });
    const before = NodeFS.readFileSync(NodePath.join(stateDir, "connection-catalog.json"), "utf8");

    const result = await reencryptLegacySecrets({
      stateDir,
      ...newKey,
      legacyPasswords: async () => {
        throw new Error("the keychain must not be read");
      },
    });

    expect(result).toEqual({ examined: 1, alreadyCurrent: 1, reencrypted: 0, failed: 0 });
    expect(NodeFS.readFileSync(NodePath.join(stateDir, "connection-catalog.json"), "utf8")).toBe(
      before,
    );
    expect(NodeFS.readdirSync(stateDir)).toEqual(["connection-catalog.json"]);
  });

  it("counts a value no key reads as failed and leaves the file alone", async () => {
    writeJson("connection-catalog.json", {
      version: 1,
      encryptedCatalog: b64(encryptChromiumV10("{}", "an-unknown-key-entirely")),
    });
    const before = NodeFS.readFileSync(NodePath.join(stateDir, "connection-catalog.json"), "utf8");

    const result = await reencryptLegacySecrets({
      stateDir,
      ...newKey,
      legacyPasswords: async () => [OLD_PASSWORD],
    });

    expect(result).toEqual({ examined: 1, alreadyCurrent: 0, reencrypted: 0, failed: 1 });
    expect(NodeFS.readFileSync(NodePath.join(stateDir, "connection-catalog.json"), "utf8")).toBe(
      before,
    );
  });

  it("treats missing state files as nothing to do", async () => {
    const result = await reencryptLegacySecrets({
      stateDir,
      ...newKey,
      legacyPasswords: async () => [],
    });
    expect(result).toEqual({ examined: 0, alreadyCurrent: 0, reencrypted: 0, failed: 0 });
  });

  it("counts a state file that is not valid JSON as failed, and still checks the others", async () => {
    NodeFS.writeFileSync(NodePath.join(stateDir, "saved-environments.json"), "not json");
    writeJson("connection-catalog.json", {
      encryptedCatalog: b64(encryptChromiumV10('{"credentials":[]}', NEW_PASSWORD)),
    });
    const result = await reencryptLegacySecrets({
      stateDir,
      ...newKey,
      legacyPasswords: async () => [],
    });
    expect(result.failed).toBe(1);
    expect(result.alreadyCurrent).toBe(1);
  });

  it("counts a state file that exists but cannot be read as failed", async () => {
    // A folder in place of the file makes the read fail with EISDIR, not ENOENT.
    NodeFS.mkdirSync(NodePath.join(stateDir, "connection-catalog.json"));
    const result = await reencryptLegacySecrets({
      stateDir,
      ...newKey,
      legacyPasswords: async () => [],
    });
    expect(result).toEqual({ examined: 0, alreadyCurrent: 0, reencrypted: 0, failed: 1 });
  });
});
