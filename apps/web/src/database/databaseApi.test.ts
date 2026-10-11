import { describe, expect, it } from "vite-plus/test";

import {
  browseTableSql,
  connectionFromEnv,
  connectionFromVault,
  connectionTarget,
  type DatabaseConnection,
  defaultConnection,
  parseDotEnv,
  VAULT_CONNECTION_PREFIX,
} from "./databaseApi";

describe("database connections", () => {
  it("reads .env values with quotes, comments and export prefixes", () => {
    expect(
      parseDotEnv(
        [
          "# app",
          'export DB_HOST="10.0.0.1"',
          "DB_PASSWORD='p#ss word'",
          "DB_PORT=3307 # dev",
        ].join("\n"),
      ),
    ).toEqual({ DB_HOST: "10.0.0.1", DB_PASSWORD: "p#ss word", DB_PORT: "3307" });
  });

  it("builds the project's connection from Laravel's DB_ keys", () => {
    expect(
      connectionFromEnv(
        "DB_CONNECTION=mariadb\nDB_HOST=127.0.0.1\nDB_PORT=3306\nDB_DATABASE=shop\nDB_USERNAME=root\nDB_PASSWORD=",
        "/srv/shop",
      ),
    ).toMatchObject({ driver: "mysql", port: 3306, database: "shop", username: "root" });
    expect(connectionFromEnv("DB_CONNECTION=sqlite", "/srv/shop/")?.database).toBe(
      "/srv/shop/database/database.sqlite",
    );
    expect(connectionFromEnv("APP_NAME=x", "/srv/shop")).toBeNull();
  });

  it("prefers the picked connection, then the project's .env one", () => {
    const env = connectionFromEnv("DB_CONNECTION=pgsql\nDB_DATABASE=shop", "/srv")!;
    const saved: DatabaseConnection = { ...env, id: "a1", name: "staging", source: "manual" };
    expect(defaultConnection([env, saved], "a1")?.id).toBe("a1");
    expect(defaultConnection([saved, env], null)?.id).toBe(env.id);
    expect(defaultConnection([], null)).toBeNull();
  });

  it("quotes table names the way the driver expects", () => {
    expect(browseTableSql("mysql", "order`s")).toBe("select * from `order``s` limit 100");
    expect(browseTableSql("pgsql", "audit.events")).toBe(
      'select * from "audit"."events" limit 100',
    );
    expect(browseTableSql("sqlite", "users")).toBe('select * from "users" limit 100');
  });
});

describe("connectionFromVault", () => {
  it("keeps the entry id and never carries a password", () => {
    const connection = connectionFromVault({
      id: "entry-1",
      name: "ohdear",
      driver: "pgsql",
      host: "10.44.0.7",
      port: 5432,
      database: "ohdear",
      username: "ohdear_main",
      tls: "disabled",
    });
    expect(connection).toMatchObject({
      id: `${VAULT_CONNECTION_PREFIX}entry-1`,
      source: "vault",
      vaultItemId: "entry-1",
      password: "",
    });
    expect(connectionTarget(connection)).toBe("10.44.0.7:5432/ohdear");
  });
});
