// @effect-diagnostics nodeBuiltinImport:off -- The test seeds a real SQLite file with Node.
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeSqlite from "node:sqlite";
import { afterAll, beforeEach, describe, expect, it, vi } from "vite-plus/test";

const driver = vi.hoisted(() => ({
  postgresStatements: [] as Array<{ sql: string; args: unknown; options: unknown }>,
  mysqlOptions: [] as unknown[],
  mysqlStatements: [] as string[],
  /** The next MySQL query fails with this error code, as when the server drops the connection. */
  mysqlFailNext: null as string | null,
}));

// The network drivers are replaced, so these tests can check how user SQL reaches them.
vi.mock("postgres", () => ({
  default: () => {
    const client = {
      unsafe: async (sql: string, args?: unknown, options?: unknown) => {
        driver.postgresStatements.push({ sql, args, options });
        return Object.assign([], { columns: [] });
      },
      release: () => undefined,
    };
    return { reserve: async () => client, end: async () => undefined };
  },
}));
vi.mock("mysql2/promise", () => ({
  default: {
    createConnection: async (options: unknown) => {
      driver.mysqlOptions.push(options);
      return {
        query: async (query: string | { sql: string }) => {
          const sql = typeof query === "string" ? query : query.sql;
          if (driver.mysqlFailNext && !sql.startsWith("SET SESSION")) {
            const code = driver.mysqlFailNext;
            driver.mysqlFailNext = null;
            throw Object.assign(new Error("Connection lost: The server closed the connection."), {
              code,
            });
          }
          driver.mysqlStatements.push(sql);
          return [[], []];
        },
        end: async () => undefined,
        destroy: () => undefined,
      };
    },
  },
}));

import { closeDatabaseSessions, runDatabase } from "./database.ts";

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

  it("runs only the first statement of stacked SQLite statements", async () => {
    await runDatabase({
      connection,
      operation: "query",
      sql: "select 1; delete from users",
    });
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

  it("reports a locked Vault as the call's error", async () => {
    await closeDatabaseSessions();
    const result = await runDatabase(
      {
        connection: {
          ...connection,
          driver: "mysql",
          host: "db.test",
          vaultItemId: "entry-locked",
        },
        operation: "tables",
      },
      async () => {
        throw new Error("Vault is locked. Unlock Vault to use this connection.");
      },
    );
    expect(result.error).toBe("Vault is locked. Unlock Vault to use this connection.");
  });

  describe("network drivers", () => {
    const remote = { ...connection, host: "db.test", database: "app" };

    beforeEach(async () => {
      await closeDatabaseSessions();
      driver.postgresStatements.length = 0;
      driver.mysqlOptions.length = 0;
      driver.mysqlStatements.length = 0;
      driver.mysqlFailNext = null;
    });

    it("keeps one MySQL connection open and sets it read-only once", async () => {
      const mysqlConnection = { ...remote, driver: "mysql" as const };
      await runDatabase({ connection: mysqlConnection, operation: "tables" });
      await runDatabase({ connection: mysqlConnection, operation: "query", sql: "select 1" });
      await runDatabase({ connection: mysqlConnection, operation: "query", sql: "select 2" });

      expect(driver.mysqlOptions).toHaveLength(1);
      expect(driver.mysqlStatements[0]).toBe("SET SESSION TRANSACTION READ ONLY");
      expect(driver.mysqlStatements.filter((sql) => sql.startsWith("SET SESSION"))).toHaveLength(1);
      expect(driver.mysqlStatements).toContain("select 2");
      expect(driver.mysqlStatements).not.toContain("START TRANSACTION READ ONLY");
    });

    it("asks Vault once per connection, not per call", async () => {
      const calls: Array<[string, boolean]> = [];
      const resolve = async (itemID: string, allowUnlock: boolean) => {
        calls.push([itemID, allowUnlock]);
        return { ...remote, driver: "mysql" as const, password: "secret" };
      };
      const vaultConnection = { ...remote, driver: "mysql" as const, vaultItemId: "entry-1" };

      await runDatabase(
        { connection: vaultConnection, allowUnlock: true, operation: "tables" },
        resolve,
      );
      await runDatabase(
        { connection: vaultConnection, operation: "query", sql: "select 1" },
        resolve,
      );

      expect(calls).toEqual([["entry-1", true]]);
      expect(driver.mysqlOptions).toEqual([expect.objectContaining({ password: "secret" })]);
    });

    it("opens a new connection once when the server dropped the old one", async () => {
      const mysqlConnection = { ...remote, driver: "mysql" as const };
      await runDatabase({ connection: mysqlConnection, operation: "tables" });
      driver.mysqlFailNext = "PROTOCOL_CONNECTION_LOST";

      const result = await runDatabase({
        connection: mysqlConnection,
        operation: "query",
        sql: "select 3",
      });

      expect(result.error).toBeNull();
      expect(driver.mysqlOptions).toHaveLength(2);
      expect(driver.mysqlStatements).toContain("select 3");
    });

    it("keeps the connection after a query error", async () => {
      const mysqlConnection = { ...remote, driver: "mysql" as const };
      await runDatabase({ connection: mysqlConnection, operation: "tables" });
      driver.mysqlFailNext = "ER_PARSE_ERROR";

      await runDatabase({ connection: mysqlConnection, operation: "query", sql: "select oops" });
      await runDatabase({ connection: mysqlConnection, operation: "query", sql: "select 4" });

      expect(driver.mysqlOptions).toHaveLength(1);
    });

    it("keeps the PostgreSQL session read-only before it runs user SQL", async () => {
      const sql = "select 1; commit; delete from users";
      const result = await runDatabase({
        connection: { ...remote, driver: "pgsql" },
        operation: "query",
        sql,
      });
      expect(result.error).toBeNull();

      const statements = driver.postgresStatements.map((statement) => statement.sql);
      const readOnly = statements.findIndex((statement) =>
        statement.includes("default_transaction_read_only = on"),
      );
      const begin = statements.indexOf("begin read only");
      expect(readOnly).toBeGreaterThanOrEqual(0);
      expect(readOnly).toBeLessThan(begin);
      expect(begin).toBeLessThan(statements.indexOf(sql));
    });

    it("sends PostgreSQL user SQL through the extended protocol", async () => {
      await runDatabase({
        connection: { ...remote, driver: "pgsql" },
        operation: "query",
        sql: "select 1; commit; delete from users",
      });
      const user = driver.postgresStatements.find((statement) =>
        statement.sql.startsWith("select 1"),
      );
      expect(user?.options).toMatchObject({ simple: false });
      // Catalog queries use the same single-statement path.
      await runDatabase({ connection: { ...remote, driver: "pgsql" }, operation: "tables" });
      for (const statement of driver.postgresStatements.filter((entry) => entry.options)) {
        expect(statement.options).toMatchObject({ simple: false });
      }
    });

    it("does not allow stacked statements on MySQL", async () => {
      await runDatabase({
        connection: { ...remote, driver: "mysql" },
        operation: "query",
        sql: "select 1",
      });
      expect(driver.mysqlOptions).toEqual([expect.objectContaining({ multipleStatements: false })]);
    });
  });
});
