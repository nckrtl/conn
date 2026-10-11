// @effect-diagnostics nodeBuiltinImport:off -- The test writes a fake relay script with Node.
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { afterAll, describe, expect, it } from "vite-plus/test";

import { listVaultDatabases, vaultCredential, VaultError } from "./vault.ts";

const dir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "conn-vault-relay-"));
const log = NodePath.join(dir, "requests.jsonl");

const entry = {
  id: "0D6B1C9E-8E3F-4F0A-9C7B-5A1E2D3C4B5A",
  name: "ohdear",
  driver: "mysql",
  host: "10.44.0.7",
  port: 3306,
  database: "ohdear",
  username: "ohdear_main",
  tls: "disabled",
};

/** A stand-in for `Vault --conn-bridge`: logs the request and answers with `reply(request)`. */
function relay(name: string, reply: string): string {
  const path = NodePath.join(dir, name);
  NodeFS.writeFileSync(
    path,
    `#!${process.execPath}
const fs = require("node:fs");
const input = fs.readFileSync(0);
const request = JSON.parse(input.subarray(4, 4 + input.readUInt32LE(0)).toString());
fs.appendFileSync(${JSON.stringify(log)}, JSON.stringify({ argv: process.argv.slice(2), request }) + "\\n");
const send = (value) => {
  const body = Buffer.from(JSON.stringify(value));
  const header = Buffer.alloc(4);
  header.writeUInt32LE(body.length);
  process.stdout.write(Buffer.concat([header, body]));
};
${reply}
`,
  );
  NodeFS.chmodSync(path, 0o755);
  return path;
}

function lastRequest(): { argv: string[]; request: Record<string, unknown> } {
  const lines = NodeFS.readFileSync(log, "utf8").trim().split("\n");
  return JSON.parse(lines.at(-1)!);
}

describe("Vault relay client", () => {
  afterAll(() => NodeFS.rmSync(dir, { recursive: true, force: true }));

  it("lists Database entries without passwords and maps postgresql to pgsql", async () => {
    const binary = relay(
      "list",
      `send({ id: "other", status: "icon" });
send({ id: request.id, status: "databases", databases: [${JSON.stringify(entry)}, { ...${JSON.stringify(entry)}, id: "B", driver: "postgresql", port: 5432 }, { ...${JSON.stringify(entry)}, id: "C", driver: "redis" }] });`,
    );

    const databases = await listVaultDatabases(false, binary);

    expect(databases.map((database) => [database.id, database.driver])).toEqual([
      [entry.id, "mysql"],
      ["B", "pgsql"],
    ]);
    expect(databases[0]).not.toHaveProperty("password");
    expect(lastRequest()).toEqual({
      argv: ["--conn-bridge"],
      request: {
        version: 1,
        id: expect.stringMatching(/^[0-9A-F-]{36}$/),
        kind: "database",
        mode: "list-database",
        allowUnlock: false,
      },
    });
  });

  it("returns one entry's credentials and asks to unlock only when allowed", async () => {
    const binary = relay(
      "credential",
      `send({ id: request.id, status: "ok", itemID: request.itemID, database: { ...${JSON.stringify(entry)}, password: "secret" } });`,
    );

    const credential = await vaultCredential(entry.id, true, binary);

    expect(credential).toMatchObject({
      host: "10.44.0.7",
      username: "ohdear_main",
      password: "secret",
    });
    expect(lastRequest().request).toMatchObject({
      mode: "database-credential",
      itemID: entry.id,
      allowUnlock: true,
    });
  });

  it("reports a locked Vault and a relay that refuses the caller", async () => {
    const locked = relay("locked", `send({ id: request.id, status: "locked" });`);
    await expect(vaultCredential(entry.id, false, locked)).rejects.toMatchObject({
      status: "locked",
    });

    const refused = relay("refused", `process.exit(1);`);
    await expect(listVaultDatabases(false, refused)).rejects.toBeInstanceOf(VaultError);
    await expect(listVaultDatabases(false, NodePath.join(dir, "missing"))).rejects.toMatchObject({
      status: "unavailable",
    });
  });
});
