import type { DesktopDatabaseConnection } from "@t3tools/contracts";
import type { DatabaseConnection } from "../../../web/src/database/databaseApi";
import { labDatabaseRun } from "../database";

export const envDatabase: DatabaseConnection = {
  id: "env",
  source: "env",
  name: ".env",
  driver: "pgsql",
  host: "app-db.orbit",
  port: 5432,
  database: "conn_app",
  username: "conn",
  password: "",
};
export const vaultDatabase: DatabaseConnection = {
  ...envDatabase,
  id: "vault-orbit",
  source: "vault",
  name: "Orbit development",
  host: "orbit-db",
  database: "orbit_dev",
};
export const tableNames = (connection: DesktopDatabaseConnection) =>
  labDatabaseRun({ connection, operation: "tables" }).tables;
export const describeTable = (connection: DesktopDatabaseConnection, table: string) =>
  labDatabaseRun({ connection, table, operation: "describe" }).columns;

export type LabQueryResult = {
  columns: string[];
  rows: (string | number | null)[][];
  truncated: boolean;
  durationMs: number;
};
export type LabQueryReply = { result: LabQueryResult } | { error: string };
