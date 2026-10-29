// The Database panel's connections and calls. The desktop main process connects directly
// (`databaseRun` IPC); connections come from the project's `.env`, are added by hand, or are
// Database entries in the Vault Mac app, whose credentials the desktop app fetches per call.
import type {
  DesktopDatabaseColumn,
  DesktopDatabaseConnection,
  DesktopDatabaseResponse,
  DesktopVaultDatabase,
} from "@t3tools/contracts";
import { APP_BASE_NAME } from "../branding";

export type DatabaseDriver = DesktopDatabaseConnection["driver"];
export type DatabaseColumn = DesktopDatabaseColumn;
export type DatabaseValue = string | number | boolean | null;

export interface DatabaseConnection extends DesktopDatabaseConnection {
  readonly id: string;
  readonly name: string;
  /**
   * `env`: read from the project's `.env` on every open; `manual`: saved in the panel;
   * `vault`: a Vault entry, listed without its password and never saved.
   */
  readonly source: "env" | "manual" | "vault";
  /** Vault entries: the SSH host the database is reached through, or null. */
  readonly sshHost?: string | null;
  /** Vault entries: the organization's name, or null for the personal vault. */
  readonly organization?: string | null;
}

export interface DatabaseQueryResult {
  readonly columns: readonly string[];
  readonly rows: ReadonlyArray<Readonly<Record<string, DatabaseValue>>>;
  readonly rowCount: number;
  /** The panel keeps the first 500 rows. */
  readonly truncated: boolean;
  readonly durationMs: number;
}

export const ENV_CONNECTION_ID = "env";

export const DRIVER_LABELS: Record<DatabaseDriver, string> = {
  mysql: "MySQL / MariaDB",
  pgsql: "PostgreSQL",
  sqlite: "SQLite",
};

/** `KEY=value` lines; quotes stripped, comments and `export ` prefixes ignored. */
export function parseDotEnv(contents: string): Record<string, string> {
  const values: Record<string, string> = {};
  for (const raw of contents.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const match = /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line);
    if (!match) continue;
    let value = match[2]!.trim();
    const quote = value[0];
    if ((quote === '"' || quote === "'") && value.endsWith(quote) && value.length >= 2) {
      value = value.slice(1, -1);
    } else {
      value = value.replace(/\s+#.*$/, "");
    }
    values[match[1]!] = value;
  }
  return values;
}

function driverFor(connection: string | undefined): DatabaseDriver | null {
  switch ((connection ?? "").toLowerCase()) {
    case "mysql":
    case "mariadb":
      return "mysql";
    case "pgsql":
    case "postgres":
    case "postgresql":
      return "pgsql";
    case "sqlite":
      return "sqlite";
    default:
      return null;
  }
}

function joinPath(root: string, path: string): string {
  if (path.startsWith("/") || /^[A-Za-z]:[\\/]/.test(path)) return path;
  return `${root.replace(/[\\/]+$/, "")}/${path}`;
}

/** The Laravel-style `DB_*` connection in a project's `.env`, or null when it has none. */
export function connectionFromEnv(
  contents: string,
  projectRoot: string,
): DatabaseConnection | null {
  const env = parseDotEnv(contents);
  const driver = driverFor(env.DB_CONNECTION);
  if (!driver) return null;
  const port = Number.parseInt(env.DB_PORT ?? "", 10);
  return {
    id: ENV_CONNECTION_ID,
    name: ".env",
    source: "env",
    driver,
    host: env.DB_HOST ?? "127.0.0.1",
    port: Number.isFinite(port) ? port : null,
    database:
      driver === "sqlite"
        ? joinPath(projectRoot, env.DB_DATABASE || "database/database.sqlite")
        : (env.DB_DATABASE ?? ""),
    username: env.DB_USERNAME ?? "",
    password: env.DB_PASSWORD ?? "",
  };
}

export const VAULT_CONNECTION_PREFIX = "vault:";

/** A Vault Database entry as a panel connection. It has no password; the desktop app fetches it. */
export function connectionFromVault(entry: DesktopVaultDatabase): DatabaseConnection {
  return {
    id: `${VAULT_CONNECTION_PREFIX}${entry.id}`,
    name: entry.name,
    source: "vault",
    driver: entry.driver,
    host: entry.host,
    port: entry.port,
    database: entry.database,
    username: entry.username,
    password: "",
    vaultItemId: entry.id,
    sshHost: entry.sshHost,
    organization: entry.organization,
  };
}

/** Vault connections by where they live: the personal vault first, then each organization. */
export function vaultGroups(
  connections: readonly DatabaseConnection[],
): Array<{ readonly label: string; readonly connections: DatabaseConnection[] }> {
  const groups = new Map<string, DatabaseConnection[]>();
  for (const connection of connections) {
    const label = connection.organization ?? "Personal";
    groups.set(label, [...(groups.get(label) ?? []), connection]);
  }
  return [...groups.entries()]
    .sort(([a], [b]) => (a === "Personal" ? -1 : b === "Personal" ? 1 : a.localeCompare(b)))
    .map(([label, entries]) => ({ label, connections: entries }));
}

/** `host/database` for the menu; the file name for SQLite. */
export function connectionTarget(
  connection: DesktopDatabaseConnection & { readonly sshHost?: string | null },
): string {
  if (connection.driver === "sqlite") {
    return connection.database.split(/[\\/]/).pop() || connection.database;
  }
  if (connection.sshHost) return `${connection.database} via ${connection.sshHost}`;
  return `${connection.host}${connection.port ? `:${connection.port}` : ""}/${connection.database}`;
}

/** The connection picked before, else the project's `.env` one, else the first. */
export function defaultConnection(
  connections: readonly DatabaseConnection[],
  remembered: string | null,
): DatabaseConnection | null {
  return (
    connections.find((connection) => connection.id === remembered) ??
    connections.find((connection) => connection.source === "env") ??
    connections[0] ??
    null
  );
}

const UNREACHABLE = /ECONNREFUSED|ETIMEDOUT|ENOTFOUND|EHOSTUNREACH|connect timeout|timed out/i;

/** `allowUnlock`: the call follows a user action, so a locked Vault may ask for Touch ID. */
export interface CallOptions {
  readonly allowUnlock?: boolean;
  /** Close the open connection first, so changed credentials are read again. */
  readonly reconnect?: boolean;
}

async function call(
  connection: DesktopDatabaseConnection,
  request: { operation: "tables" | "describe" | "query"; table?: string; sql?: string },
  options: CallOptions = {},
): Promise<DesktopDatabaseResponse> {
  const run = window.desktopBridge?.databaseRun;
  if (!run) throw new Error(`The Database panel needs the ${APP_BASE_NAME} desktop app.`);
  const { host, port, driver, database, username, password, vaultItemId } = connection;
  const response = await run({
    connection: {
      host,
      port,
      driver,
      database,
      username,
      password,
      ...(vaultItemId ? { vaultItemId } : {}),
    },
    ...(options.allowUnlock ? { allowUnlock: true } : {}),
    ...(options.reconnect ? { reconnect: true } : {}),
    ...request,
  });
  if (response.error) {
    throw new Error(
      UNREACHABLE.test(response.error)
        ? `${response.error}. The desktop app connects from this Mac; for a database on another machine, add a connection with a host this Mac can reach.`
        : response.error,
    );
  }
  return response;
}

export async function listDatabaseTables(
  connection: DesktopDatabaseConnection,
  options?: CallOptions,
): Promise<string[]> {
  return [...(await call(connection, { operation: "tables" }, options)).tables];
}

export async function describeDatabaseTable(
  connection: DesktopDatabaseConnection,
  table: string,
  options?: CallOptions,
): Promise<DatabaseColumn[]> {
  return [...(await call(connection, { operation: "describe", table }, options)).columns];
}

export async function runReadOnlyQuery(
  connection: DesktopDatabaseConnection,
  sql: string,
  options?: CallOptions,
): Promise<DatabaseQueryResult> {
  const response = await call(connection, { operation: "query", sql }, options);
  return {
    columns: response.resultColumns,
    rows: response.rows,
    rowCount: response.rowCount,
    truncated: response.truncated,
    durationMs: response.durationMs,
  };
}

/** `select * from <table> limit 100`, with the driver's identifier quoting. */
export function browseTableSql(driver: DatabaseDriver, table: string): string {
  if (driver === "mysql") return `select * from \`${table.replace(/`/g, "``")}\` limit 100`;
  const quote = (part: string) => `"${part.replace(/"/g, '""')}"`;
  // PostgreSQL lists tables outside `public` as `schema.table`.
  const name =
    driver === "pgsql" && table.includes(".")
      ? `${quote(table.slice(0, table.indexOf(".")))}.${quote(table.slice(table.indexOf(".") + 1))}`
      : quote(table);
  return `select * from ${name} limit 100`;
}
