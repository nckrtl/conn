// Run only inside a worker so slow joins can be cancelled by leaving the panel.
import initSqlJs, { type Database } from "sql.js";
import wasm from "sql.js/dist/sql-wasm-browser.wasm?url";
import { labDatabaseRun } from "../database";
import {
  describeTable,
  envDatabase,
  tableNames,
  type LabQueryReply,
  type LabQueryResult,
} from "./databaseFixture";

self.onmessage = async (event: MessageEvent<string>) => {
  // oxlint-disable-next-line unicorn/require-post-message-target-origin -- Dedicated worker message, not a window message.
  const reply = (value: LabQueryReply) => self.postMessage(value);
  let db: Database | undefined;
  try {
    const SQL = await initSqlJs({ locateFile: () => wasm });
    db = new SQL.Database();
    for (const name of tableNames(envDatabase)) {
      const columns = describeTable(envDatabase, name);
      const statement = 'select * from "' + name + '"';
      const { rows } = labDatabaseRun({
        connection: envDatabase,
        operation: "query",
        sql: statement,
      });
      db.run(
        'CREATE TABLE "' + name + '" (' + columns.map((c) => '"' + c.name + '"').join(", ") + ")",
      );
      const insert = db.prepare(
        'INSERT INTO "' + name + '" VALUES (' + columns.map(() => "?").join(", ") + ")",
      );
      try {
        for (const row of rows) {
          insert.run(
            columns.map((c) => {
              const value = row[c.name];
              return typeof value === "boolean" ? Number(value) : (value ?? null);
            }),
          );
        }
      } finally {
        insert.free();
      }
    }
    db.run("PRAGMA query_only=ON");
    const start = performance.now();
    let result: LabQueryResult | undefined;
    for (const statement of db.iterateStatements(event.data)) {
      const sql = statement.getSQL().replace(/^(?:\s|--[^\n]*(?:\n|$)|\/\*[\s\S]*?\*\/)+/, "");
      if (result || !/^(?:SELECT|WITH)\b/i.test(sql))
        throw new Error("Run one read-only SELECT statement at a time.");
      const columns = statement.getColumnNames();
      const rows: LabQueryResult["rows"] = [];
      let truncated = false;
      while (statement.step()) {
        if (rows.length === 500) {
          truncated = true;
          break;
        }
        rows.push(
          statement.get().map((value) => (value instanceof Uint8Array ? "[binary]" : value)),
        );
      }
      result = { columns, rows, truncated, durationMs: Math.round(performance.now() - start) };
    }
    if (!result) throw new Error("Enter a SELECT statement.");
    reply({ result });
  } catch (error) {
    reply({ error: error instanceof Error ? error.message : String(error) });
  } finally {
    db?.close();
  }
};
