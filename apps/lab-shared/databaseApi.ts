// The Database panel helpers the desktop lab renders with, from apps/web/src/database/databaseApi.ts.
import type { DesktopDatabaseConnection } from "./contracts";

export type DatabaseDriver = DesktopDatabaseConnection["driver"];

export interface DatabaseConnection extends DesktopDatabaseConnection {
  readonly id: string;
  readonly name: string;
  readonly source: "env" | "manual" | "vault";
  readonly sshHost?: string | null;
  readonly organization?: string | null;
}

export const DRIVER_LABELS: Record<DatabaseDriver, string> = {
  mysql: "MySQL / MariaDB",
  pgsql: "PostgreSQL",
  sqlite: "SQLite",
};

export function connectionTarget(
  connection: DesktopDatabaseConnection & { readonly sshHost?: string | null },
): string {
  if (connection.driver === "sqlite") {
    return connection.database.split(/[\\/]/).pop() || connection.database;
  }
  if (connection.sshHost) return `${connection.database} via ${connection.sshHost}`;
  return `${connection.host}${connection.port ? `:${connection.port}` : ""}/${connection.database}`;
}

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
