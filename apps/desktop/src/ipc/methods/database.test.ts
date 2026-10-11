// @effect-diagnostics nodeBuiltinImport:off -- The test seeds a real SQLite file with Node.
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeSqlite from "node:sqlite";
import { afterAll, describe, expect, it } from "vite-plus/test";

import { runDatabase } from "./database.ts";

const dir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-database-panel-"));
const file = NodePath.join(dir, "app.sqlite");
const seed = new NodeSqlite.DatabaseSync(file);
seed.exec(
  "create table users (id integer primary key, name text not null, born text default 'now'); insert into users (name) values ('ada'), ('grace');",
);
seed.close();

const connection = {
  driver: "sqlite" as const,
  host: "",
  port: null,
  database: file,
  username: "",
  password: "",
};

describe("database panel runner", () => {
  afterAll(() => NodeFS.rmSync(dir, { recursive: true, force: true }));

  it("lists tables, describes columns and runs a select", async () => {
    expect((await runDatabase({ connection, operation: "tables" })).tables).toEqual(["users"]);
    const described = await runDatabase({ connection, operation: "describe", table: "users" });
    expect(
      described.columns.map((column) => [column.name, column.primary, column.nullable]),
    ).toEqual([
      ["id", true, true],
      ["name", false, false],
      ["born", false, true],
    ]);
    const query = await runDatabase({
      connection,
      operation: "query",
      sql: "-- newest first\nselect id, name from users order by id desc",
    });
    expect(query.error).toBeNull();
    expect(query.resultColumns).toEqual(["id", "name"]);
    expect(query.rows).toEqual([
      { id: 2, name: "grace" },
      { id: 1, name: "ada" },
    ]);
  });

  it("refuses statements that change data or schema", async () => {
    for (const sql of [
      "delete from users",
      "drop table users",
      "/* x */ update users set name = ''",
    ]) {
      const result = await runDatabase({ connection, operation: "query", sql });
      expect(result.error).toMatch(/read-only/);
    }
    // A write hidden behind a reading keyword still fails: the file is opened read-only.
    const hidden = await runDatabase({
      connection,
      operation: "query",
      sql: "with x as (select 1) insert into users (name) select 'eve' from x",
    });
    expect(hidden.error).not.toBeNull();
    expect(
      (
        await runDatabase({
          connection,
          operation: "query",
          sql: "select count(*) as n from users",
        })
      ).rows,
    ).toEqual([{ n: 2 }]);
  });

  it("fetches a Vault connection's credentials for each call", async () => {
    const calls: Array<[string, boolean]> = [];
    const resolve = async (itemID: string, allowUnlock: boolean) => {
      calls.push([itemID, allowUnlock]);
      return connection;
    };
    const vaultConnection = { ...connection, database: "", vaultItemId: "entry-1" };

    const result = await runDatabase({ connection: vaultConnection, operation: "tables" }, resolve);
    await runDatabase(
      { connection: vaultConnection, allowUnlock: true, operation: "tables" },
      resolve,
    );

    expect(result.tables).toEqual(["users"]);
    expect(calls).toEqual([
      ["entry-1", false],
      ["entry-1", true],
    ]);
  });

  it("reports a locked Vault as the call's error", async () => {
    const result = await runDatabase(
      { connection: { ...connection, vaultItemId: "entry-1" }, operation: "tables" },
      async () => {
        throw new Error("Vault is locked. Unlock Vault to use this connection.");
      },
    );
    expect(result.error).toBe("Vault is locked. Unlock Vault to use this connection.");
  });
});
