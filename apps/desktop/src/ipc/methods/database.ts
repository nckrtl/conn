// @effect-diagnostics globalTimers:off -- The idle timer of an open database connection runs outside any Effect fiber.
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import mysql from "mysql2/promise";
import * as NodeSqlite from "node:sqlite";
import postgres from "postgres";

import * as DesktopIpc from "../DesktopIpc.ts";
import { DATABASE_RUN_CHANNEL } from "../channels.ts";
import { openSshTunnel, type SshTunnel } from "./sshTunnel.ts";
import { vaultCredential, type VaultTls } from "./vault.ts";

// The Database panel's runner. The desktop main process connects directly (no T3 server
// change) and keeps one open connection per database, so a query costs one round trip instead
// of a new login each time. A connection closes after IDLE_MS without use. Everything is
// read-only: only reading statements may run. MySQL sessions are set read-only once; PostgreSQL
// runs each call in a pipelined read-only transaction that is rolled back, which also undoes any
// session setting a query changes. SQLite opens the file read-only. A Vault connection carries
// only its entry id; Vault is asked for its credentials when the connection opens, and they live
// only as long as that connection.

const ROW_LIMIT = 500;
const TIMEOUT_SECONDS = 30;
const IDLE_MS = 5 * 60_000;

const Connection = Schema.Struct({
  driver: Schema.Literals(["mysql", "pgsql", "sqlite"]),
  host: Schema.String,
  port: Schema.NullOr(Schema.Int),
  database: Schema.String,
  username: Schema.String,
  password: Schema.String,
  vaultItemId: Schema.optional(Schema.String.check(Schema.isMaxLength(64))),
});

const DatabaseRequest = Schema.Struct({
  connection: Connection,
  /** Whether a locked Vault may ask for Touch ID. Only explicit actions set it. */
  allowUnlock: Schema.optional(Schema.Boolean),
  /** Close an open connection first, so a changed Vault entry or `.env` is read again. */
  reconnect: Schema.optional(Schema.Boolean),
  operation: Schema.Literals(["tables", "describe", "query"]),
  table: Schema.optional(Schema.String),
  sql: Schema.optional(Schema.String.check(Schema.isMaxLength(200_000))),
});

const Column = Schema.Struct({
  name: Schema.String,
  type: Schema.String,
  nullable: Schema.Boolean,
  default: Schema.NullOr(Schema.String),
  primary: Schema.Boolean,
});

const Value = Schema.Union([Schema.String, Schema.Number, Schema.Boolean, Schema.Null]);

const DatabaseResponse = Schema.Struct({
  error: Schema.NullOr(Schema.String),
  tables: Schema.Array(Schema.String),
  columns: Schema.Array(Column),
  resultColumns: Schema.Array(Schema.String),
  rows: Schema.Array(Schema.Record(Schema.String, Value)),
  rowCount: Schema.Int,
  truncated: Schema.Boolean,
  durationMs: Schema.Number,
});

type Request = typeof DatabaseRequest.Type;
/**
 * A connection ready to open. `tls` and the SSH fields come only from a Vault entry; with an SSH
 * host, `host` and `port` are the database as the SSH server reaches it.
 */
type Resolved = Request["connection"] & {
  readonly tls?: VaultTls;
  readonly sshHost?: string | null;
  readonly sshPort?: number | null;
  readonly sshUser?: string | null;
  readonly sshAgent?: string | null;
};
export type VaultResolver = (
  itemID: string,
  allowUnlock: boolean,
) => Promise<Omit<Resolved, "vaultItemId">>;
type Response = typeof DatabaseResponse.Type;
type Column = typeof Column.Type;
type CellValue = typeof Value.Type;
type Row = Record<string, CellValue>;

interface Rows {
  readonly columns: readonly string[];
  readonly rows: readonly Record<string, unknown>[];
}

const READING_STATEMENT = /^(select|with|show|describe|desc|explain|values|table|pragma)\b/i;

/** Drops leading comments, so `-- note\nselect 1` counts as a select. */
function firstKeyword(sql: string): string {
  return sql.replace(/^(\s+|--[^\n]*\n?|\/\*[\s\S]*?\*\/)*/, "").trimStart();
}

function assertReading(sql: string): void {
  if (!READING_STATEMENT.test(firstKeyword(sql))) {
    throw new Error(
      "The Database panel is read-only. Run select, with, show, describe or explain statements.",
    );
  }
}

/** Values the panel can show: dates as ISO text, binary as hex, big numbers as text. */
function cell(value: unknown): CellValue {
  if (value === null || value === undefined) return null;
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
    return value;
  }
  if (typeof value === "bigint") return value.toString();
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value.toISOString();
  if (value instanceof Uint8Array) {
    const hex = Buffer.from(value.subarray(0, 64)).toString("hex");
    return `0x${hex}${value.byteLength > 64 ? `… (${value.byteLength} bytes)` : ""}`;
  }
  return JSON.stringify(value);
}

function limitRows(
  result: Rows,
): Pick<Response, "resultColumns" | "rows" | "rowCount" | "truncated"> {
  const kept = result.rows.slice(0, ROW_LIMIT).map((row) => {
    const out: Row = {};
    for (const column of result.columns) out[column] = cell(row[column]);
    return out;
  });
  return {
    resultColumns: [...result.columns],
    rows: kept,
    rowCount: result.rows.length,
    truncated: result.rows.length > ROW_LIMIT,
  };
}

function text(value: unknown): string {
  return value === null || value === undefined ? "" : String(value);
}

// ─── MySQL / MariaDB ─────────────────────────────────────────────────────────

/** TLS options for both drivers. `required` encrypts without checking the certificate. */
function tlsOptions(tls: VaultTls | undefined) {
  switch (tls) {
    case "required":
      return { rejectUnauthorized: false };
    case "verify-ca":
      return { rejectUnauthorized: true, checkServerIdentity: () => undefined };
    case "verify-full":
      return { rejectUnauthorized: true };
    default:
      return undefined;
  }
}

/** The `ssl` option for a connection, or nothing when TLS is off. */
function tlsSetting(tls: VaultTls | undefined) {
  const ssl = tlsOptions(tls);
  return ssl ? { ssl } : {};
}

async function openMysql(connection: Resolved): Promise<Session<mysql.Connection>> {
  const client = await mysql.createConnection({
    host: connection.host || "127.0.0.1",
    port: connection.port ?? 3306,
    user: connection.username,
    password: connection.password,
    database: connection.database,
    connectTimeout: 10_000,
    dateStrings: true,
    supportBigNumbers: true,
    bigNumberStrings: true,
    multipleStatements: false,
    ...tlsSetting(connection.tls),
  });
  // Every later statement runs read-only. `set` is not a reading statement, so a query cannot undo it.
  await client.query("SET SESSION TRANSACTION READ ONLY");
  return {
    client,
    driver: "mysql",
    close: () => client.end().catch(() => client.destroy()),
  };
}

async function mysqlRows(client: mysql.Connection, sql: string, values: unknown[] = []) {
  const [rows, fields] = await client.query({ sql, values, timeout: TIMEOUT_SECONDS * 1000 });
  if (!Array.isArray(rows)) return { columns: [], rows: [] };
  return {
    columns: (fields ?? []).map((field) => field.name),
    rows: rows as Record<string, unknown>[],
  };
}

async function runMysql(client: mysql.Connection, request: Request): Promise<Partial<Response>> {
  {
    if (request.operation === "tables") {
      const result = await mysqlRows(
        client,
        "select table_name as name from information_schema.tables where table_schema = database() order by table_name",
      );
      return { tables: result.rows.map((row) => text(row.name ?? row.NAME ?? row.TABLE_NAME)) };
    }
    if (request.operation === "describe") {
      const result = await mysqlRows(
        client,
        "select column_name as name, column_type as type, is_nullable as nullable, column_default as dflt, column_key as ckey from information_schema.columns where table_schema = database() and table_name = ? order by ordinal_position",
        [request.table ?? ""],
      );
      return {
        columns: result.rows.map((row) => ({
          name: text(row.name),
          type: text(row.type),
          nullable: text(row.nullable) === "YES",
          default: row.dflt === null || row.dflt === undefined ? null : text(row.dflt),
          primary: text(row.ckey) === "PRI",
        })),
      };
    }
    return limitRows(await mysqlRows(client, request.sql ?? ""));
  }
}

// ─── PostgreSQL ──────────────────────────────────────────────────────────────

async function openPostgres(connection: Resolved): Promise<Session<postgres.ReservedSql>> {
  const sql = postgres({
    host: connection.host || "127.0.0.1",
    port: connection.port ?? 5432,
    user: connection.username,
    password: connection.password,
    database: connection.database,
    max: 1,
    prepare: false,
    connect_timeout: 10,
    idle_timeout: 0,
    onnotice: () => undefined,
    ...tlsSetting(connection.tls),
  });
  try {
    const client = await sql.reserve();
    await client.unsafe(
      `set statement_timeout = ${TIMEOUT_SECONDS * 1000}; set default_transaction_read_only = on`,
    );
    return {
      client,
      driver: "pgsql",
      close: async () => {
        client.release();
        await sql.end({ timeout: 1 }).catch(() => undefined);
      },
    };
  } catch (error) {
    await sql.end({ timeout: 1 }).catch(() => undefined);
    throw error;
  }
}

/**
 * Runs `run` inside `begin read only` … `rollback`. The three are pipelined on the connection,
 * so the transaction adds no round trip, and the rollback undoes any setting the query changed.
 */
async function postgresReadOnly<T>(
  client: postgres.ReservedSql,
  run: () => Promise<T>,
): Promise<T> {
  const begin = client.unsafe("begin read only");
  const result = run();
  const rollback = client.unsafe("rollback");
  // If `begin` fails, its error is the one to report; the query's own failure is then expected.
  result.catch(() => undefined);
  await begin;
  try {
    return await result;
  } finally {
    await rollback.catch(() => undefined);
  }
}

/**
 * `simple: false` sends the SQL through the extended protocol, where PostgreSQL accepts one
 * statement only. The default for a query without parameters is the simple protocol, which
 * runs `select 1; commit; delete ...` as three statements. `postgres` reads this option at
 * runtime (`unsafe` in postgres/src/index.js) but does not declare it in its types.
 */
const POSTGRES_SINGLE_STATEMENT = {
  prepare: false,
  simple: false,
} as postgres.UnsafeQueryOptions;

async function postgresRows(
  client: postgres.ReservedSql,
  sql: string,
  values: postgres.ParameterOrJSON<never>[] = [],
): Promise<Rows> {
  const result = await client.unsafe(sql, values, POSTGRES_SINGLE_STATEMENT);
  return {
    columns: (result.columns ?? []).map((column) => column.name),
    rows: [...result] as Record<string, unknown>[],
  };
}

/** `schema.table` or a bare table in `public`. */
function postgresTable(name: string): [string, string] {
  const dot = name.indexOf(".");
  return dot === -1 ? ["public", name] : [name.slice(0, dot), name.slice(dot + 1)];
}

async function runPostgres(
  client: postgres.ReservedSql,
  request: Request,
): Promise<Partial<Response>> {
  return postgresReadOnly(client, async () => {
    if (request.operation === "tables") {
      const result = await postgresRows(
        client,
        "select case when table_schema = 'public' then table_name else table_schema || '.' || table_name end as name from information_schema.tables where table_schema not in ('pg_catalog', 'information_schema') order by 1",
      );
      return { tables: result.rows.map((row) => text(row.name)) };
    }
    if (request.operation === "describe") {
      const [schema, table] = postgresTable(request.table ?? "");
      const result = await postgresRows(
        client,
        `select c.column_name as name, c.data_type as type, c.is_nullable as nullable, c.column_default as dflt,
           exists (
             select 1 from information_schema.table_constraints t
             join information_schema.key_column_usage k
               on k.constraint_name = t.constraint_name and k.table_schema = t.table_schema
             where t.constraint_type = 'PRIMARY KEY' and k.table_schema = c.table_schema
               and k.table_name = c.table_name and k.column_name = c.column_name
           ) as pk
         from information_schema.columns c
         where c.table_schema = $1 and c.table_name = $2
         order by c.ordinal_position`,
        [schema, table],
      );
      return {
        columns: result.rows.map((row) => ({
          name: text(row.name),
          type: text(row.type),
          nullable: text(row.nullable) === "YES",
          default: row.dflt === null || row.dflt === undefined ? null : text(row.dflt),
          primary: row.pk === true,
        })),
      };
    }
    return limitRows(await postgresRows(client, request.sql ?? ""));
  });
}

// ─── SQLite ──────────────────────────────────────────────────────────────────

function withSqlite<T>(
  connection: Request["connection"],
  run: (db: NodeSqlite.DatabaseSync) => T,
): T {
  const db = new NodeSqlite.DatabaseSync(connection.database, { readOnly: true });
  try {
    return run(db);
  } finally {
    db.close();
  }
}

function sqliteRows(db: NodeSqlite.DatabaseSync, sql: string): Rows {
  const statement = db.prepare(sql);
  const rows = statement.all() as Record<string, unknown>[];
  const columns = statement.columns().map((column) => column.name);
  return { columns, rows };
}

function runSqlite(request: Request): Partial<Response> {
  return withSqlite(request.connection, (db) => {
    if (request.operation === "tables") {
      return {
        tables: sqliteRows(
          db,
          "select name from sqlite_master where type in ('table', 'view') and name not like 'sqlite_%' order by name",
        ).rows.map((row) => text(row.name)),
      };
    }
    if (request.operation === "describe") {
      const table = (request.table ?? "").replace(/"/g, '""');
      return {
        columns: sqliteRows(db, `pragma table_info("${table}")`).rows.map((row): Column => ({
          name: text(row.name),
          type: text(row.type),
          nullable: Number(row.notnull) === 0,
          default:
            row.dflt_value === null || row.dflt_value === undefined ? null : text(row.dflt_value),
          primary: Number(row.pk) > 0,
        })),
      };
    }
    return limitRows(sqliteRows(db, request.sql ?? ""));
  });
}

// ─── Open connections ────────────────────────────────────────────────────────

/** Opens the driver connection, through an SSH tunnel when the entry names an SSH host. */
async function openSession(
  resolved: Resolved,
): Promise<Session<mysql.Connection> | Session<postgres.ReservedSql>> {
  let tunnel: SshTunnel | null = null;
  let target = resolved;
  if (resolved.sshHost) {
    if (!resolved.sshAgent) {
      throw new Error(
        "This connection uses SSH. Turn on Settings › SSH agent › Use Vault for SSH in Vault.",
      );
    }
    const defaultPort = resolved.driver === "pgsql" ? 5432 : 3306;
    tunnel = await openSshTunnel({
      host: resolved.sshHost,
      port: resolved.sshPort ?? null,
      user: resolved.sshUser ?? null,
      agent: resolved.sshAgent,
      remoteHost: resolved.host || "127.0.0.1",
      remotePort: resolved.port ?? defaultPort,
    });
    target = { ...resolved, host: "127.0.0.1", port: tunnel.localPort };
  }
  try {
    const session =
      target.driver === "mysql" ? await openMysql(target) : await openPostgres(target);
    if (!tunnel) return session;
    const opened = tunnel;
    return {
      ...session,
      close: async () => {
        await session.close();
        opened.close();
      },
    } as Session<mysql.Connection> | Session<postgres.ReservedSql>;
  } catch (error) {
    tunnel?.close();
    throw error;
  }
}

interface Session<Client> {
  readonly client: Client;
  readonly driver: "mysql" | "pgsql";
  readonly close: () => Promise<unknown>;
}

interface OpenSession {
  readonly session: Promise<Session<mysql.Connection> | Session<postgres.ReservedSql>>;
  /** Calls on one connection run one after another. */
  queue: Promise<unknown>;
  idle: ReturnType<typeof setTimeout> | undefined;
  /** Whether a call has succeeded. Until then an error closes it: the login may be accepted while the entry is wrong. */
  proven: boolean;
}

const sessions = new Map<string, OpenSession>();

/** A Vault entry by its id, so a rotated password reuses the open connection; others by everything. */
function sessionKey(connection: Request["connection"]): string {
  if (connection.vaultItemId) return `vault:${connection.vaultItemId}`;
  const { driver, host, port, database, username, password } = connection;
  return JSON.stringify([driver, host, port, database, username, password]);
}

function closeSession(key: string, open: OpenSession): void {
  if (sessions.get(key) !== open) return;
  sessions.delete(key);
  if (open.idle) clearTimeout(open.idle);
  void open.session.then((session) => session.close()).catch(() => undefined);
}

function touch(key: string, open: OpenSession): void {
  if (open.idle) clearTimeout(open.idle);
  open.idle = setTimeout(() => closeSession(key, open), IDLE_MS);
  open.idle.unref?.();
}

/** Closes every open connection, for tests and app shutdown. */
export async function closeDatabaseSessions(): Promise<void> {
  const open = [...sessions.entries()];
  for (const [key, entry] of open) closeSession(key, entry);
  await Promise.all(
    open.map(([, entry]) => entry.session.then((s) => s.close()).catch(() => undefined)),
  );
}

const LOST_CONNECTION =
  /PROTOCOL_CONNECTION_LOST|ECONNRESET|EPIPE|ETIMEDOUT|Connection lost|connection.*(closed|ended|terminated)|CONNECTION_(CLOSED|ENDED|DESTROYED)|Can't add new command when connection is in closed state/i;

function lostConnection(error: unknown): boolean {
  const code =
    typeof error === "object" && error !== null && "code" in error ? String(error.code) : "";
  const message = error instanceof Error ? error.message : String(error);
  return code ? LOST_CONNECTION.test(code) : LOST_CONNECTION.test(message);
}

async function withSession(
  request: Request,
  resolveVault: VaultResolver,
): Promise<Partial<Response>> {
  const key = sessionKey(request.connection);
  const stale = sessions.get(key);
  if (request.reconnect && stale) closeSession(key, stale);
  for (let attempt = 0; ; attempt++) {
    let open = sessions.get(key);
    if (!open) {
      const connection = request.connection;
      const opening = (async () => {
        const resolved: Resolved = connection.vaultItemId
          ? await resolveVault(connection.vaultItemId, request.allowUnlock ?? false)
          : connection;
        return openSession(resolved);
      })();
      open = { session: opening, queue: Promise.resolve(), idle: undefined, proven: false };
      const entry = open;
      sessions.set(key, entry);
      opening.catch(() => {
        if (sessions.get(key) === entry) sessions.delete(key);
      });
    }
    const entry = open;
    touch(key, entry);
    const call = entry.queue.then(async () => {
      const session = await entry.session;
      return session.driver === "mysql"
        ? runMysql(session.client as mysql.Connection, request)
        : runPostgres(session.client as postgres.ReservedSql, request);
    });
    entry.queue = call.catch(() => undefined);
    try {
      const result = await call;
      entry.proven = true;
      return result;
    } catch (error) {
      if (!entry.proven) closeSession(key, entry);
      if (!lostConnection(error)) throw error;
      closeSession(key, entry);
      // The server or network dropped the connection: open a new one, once.
      if (attempt > 0) throw error;
    }
  }
}

// ─── Entry ───────────────────────────────────────────────────────────────────

const EMPTY: Response = {
  error: null,
  tables: [],
  columns: [],
  resultColumns: [],
  rows: [],
  rowCount: 0,
  truncated: false,
  durationMs: 0,
};

export async function runDatabase(
  input: Request,
  resolveVault: VaultResolver = vaultCredential,
): Promise<Response> {
  const started = performance.now();
  const durationMs = () => Math.round((performance.now() - started) * 10) / 10;
  try {
    if (input.operation === "query") assertReading(input.sql ?? "");
    const result =
      input.connection.driver === "sqlite"
        ? runSqlite(input)
        : await withSession(input, resolveVault);
    return { ...EMPTY, ...result, durationMs: durationMs() };
  } catch (error) {
    return {
      ...EMPTY,
      error: error instanceof Error ? error.message : String(error),
      durationMs: durationMs(),
    };
  }
}

export const databaseRun = DesktopIpc.makeIpcMethod({
  channel: DATABASE_RUN_CHANNEL,
  payload: DatabaseRequest,
  result: DatabaseResponse,
  handler: Effect.fn("desktop.ipc.database.run")(function* (request) {
    return yield* Effect.promise(() => runDatabase(request));
  }),
});
