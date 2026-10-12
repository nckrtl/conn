// @effect-diagnostics nodeBuiltinImport:off -- The Vault relay is a child process over stdio.
import * as NodeChildProcess from "node:child_process";
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import * as DesktopIpc from "../DesktopIpc.ts";
import { VAULT_DATABASES_CHANNEL } from "../channels.ts";

// Database entries from the Vault Mac app. Each request starts Vault's signed relay
// (`Vault --conn-bridge`). The relay accepts only this app, by code signature, as its parent and
// forwards one framed request to the running Vault app, which owns the unlocked vault. A listing
// never carries a password; a password reaches this process for one database call only.

export const VAULT_BINARY = "/Applications/Vault.app/Contents/MacOS/Vault";
const TIMEOUT_MS = 120_000;
const MAX_FRAME = 64 * 1024;

export const VaultTls = Schema.Literals(["disabled", "required", "verify-ca", "verify-full"]);
export type VaultTls = typeof VaultTls.Type;
const isVaultTls = Schema.is(VaultTls);

const VaultDatabase = Schema.Struct({
  id: Schema.String,
  name: Schema.String,
  driver: Schema.Literals(["mysql", "pgsql"]),
  host: Schema.String,
  port: Schema.Int,
  database: Schema.String,
  username: Schema.String,
  tls: VaultTls,
});
export type VaultDatabase = typeof VaultDatabase.Type;

interface Wire {
  readonly id: string;
  readonly name: string;
  readonly driver: string;
  readonly host: string;
  readonly port: number;
  readonly database: string;
  readonly username: string;
  readonly tls: string;
  readonly password?: string;
}

interface Reply {
  readonly id?: string;
  readonly status?: string;
  readonly message?: string;
  readonly databases?: readonly Wire[];
  readonly database?: Wire;
}

export class VaultError extends Error {
  readonly status: "locked" | "unavailable" | "error";

  constructor(status: VaultError["status"], message: string) {
    super(message);
    this.status = status;
  }
}

function frame(payload: object): Buffer {
  const body = Buffer.from(JSON.stringify(payload), "utf8");
  const header = Buffer.alloc(4);
  header.writeUInt32LE(body.length, 0);
  return Buffer.concat([header, body]);
}

/** Sends one request through the relay and returns Vault's final reply. */
export function vaultRequest(
  mode: "list-database" | "database-credential",
  options: { readonly itemID?: string; readonly allowUnlock: boolean },
  binary: string = VAULT_BINARY,
): Promise<Reply> {
  // The binary exists only where Vault is installed, which is only ever a Mac.
  if (!NodeFS.existsSync(binary)) {
    return Promise.reject(new VaultError("unavailable", "Vault is not installed on this Mac."));
  }
  const id = NodeCrypto.randomUUID().toUpperCase();
  return new Promise((resolve, reject) => {
    // A Touch ID or password prompt can take a while; `timeout` ends a relay that never answers.
    const child = NodeChildProcess.spawn(binary, ["--conn-bridge"], {
      stdio: ["pipe", "pipe", "ignore"],
      timeout: TIMEOUT_MS,
    });
    let buffer = Buffer.alloc(0);
    let settled = false;
    const settle = (result: () => void) => {
      if (settled) return;
      settled = true;
      child.kill();
      result();
    };
    child.on("error", (error) =>
      settle(() => reject(new VaultError("unavailable", error.message))),
    );
    child.on("close", (_code, signal) =>
      settle(() =>
        reject(
          signal === "SIGTERM"
            ? new VaultError("error", "Vault did not answer in time.")
            : new VaultError(
                // Vault is installed, so the menu shows this instead of hiding its Vault section.
                "error",
                "Vault refused the request. Update Vault, and use the signed Conn app.",
              ),
        ),
      ),
    );
    child.stdout.on("data", (chunk: Buffer) => {
      buffer = Buffer.concat([buffer, chunk]);
      while (buffer.length >= 4) {
        const size = buffer.readUInt32LE(0);
        if (size === 0 || size > MAX_FRAME) {
          settle(() => reject(new VaultError("error", "Vault sent an invalid reply.")));
          return;
        }
        if (buffer.length < 4 + size) return;
        const body = buffer.subarray(4, 4 + size);
        buffer = buffer.subarray(4 + size);
        let reply: Reply;
        try {
          reply = JSON.parse(body.toString("utf8")) as Reply;
        } catch {
          settle(() => reject(new VaultError("error", "Vault sent an invalid reply.")));
          return;
        }
        if (reply.id !== id) continue;
        settle(() => resolve(reply));
        return;
      }
    });
    child.stdin.on("error", () => undefined);
    // Keep stdin open until the reply: the relay reads EOF as the caller hanging up and closes
    // its Vault connection before Vault answers. `settle` ends the relay once a reply arrives.
    child.stdin.write(
      frame({
        version: 1,
        id,
        kind: "database",
        mode,
        ...(options.itemID ? { itemID: options.itemID } : {}),
        allowUnlock: options.allowUnlock,
      }),
    );
  });
}

function toDatabase(wire: Wire): VaultDatabase | null {
  const driver = wire.driver === "postgresql" ? "pgsql" : wire.driver === "mysql" ? "mysql" : null;
  const tls = isVaultTls(wire.tls) ? wire.tls : null;
  if (!driver || !tls) return null;
  return {
    id: wire.id,
    name: wire.name,
    driver,
    host: wire.host,
    port: wire.port,
    database: wire.database,
    username: wire.username,
    tls,
  };
}

function failure(reply: Reply): VaultError {
  return reply.status === "locked"
    ? new VaultError("locked", "Vault is locked. Unlock Vault to use this connection.")
    : new VaultError("error", reply.message ?? "Vault did not return the entry.");
}

/** The Database entries in Vault, without passwords. */
export async function listVaultDatabases(
  allowUnlock: boolean,
  binary?: string,
): Promise<VaultDatabase[]> {
  const reply = await vaultRequest("list-database", { allowUnlock }, binary);
  if (reply.status !== "databases") throw failure(reply);
  return (reply.databases ?? []).flatMap((wire) => toDatabase(wire) ?? []);
}

/** One entry with its password, for a single database call. */
export async function vaultCredential(
  itemID: string,
  allowUnlock: boolean,
  binary?: string,
): Promise<VaultDatabase & { readonly password: string }> {
  const reply = await vaultRequest("database-credential", { itemID, allowUnlock }, binary);
  const database = reply.status === "ok" && reply.database ? toDatabase(reply.database) : null;
  if (!database || typeof reply.database?.password !== "string") throw failure(reply);
  return { ...database, password: reply.database.password };
}

const VaultDatabasesRequest = Schema.Struct({ allowUnlock: Schema.Boolean });

const VaultDatabasesResponse = Schema.Struct({
  status: Schema.Literals(["ok", "locked", "unavailable", "error"]),
  databases: Schema.Array(VaultDatabase),
  error: Schema.NullOr(Schema.String),
});

export const vaultDatabases = DesktopIpc.makeIpcMethod({
  channel: VAULT_DATABASES_CHANNEL,
  payload: VaultDatabasesRequest,
  result: VaultDatabasesResponse,
  handler: Effect.fn("desktop.ipc.vault.databases")(function* (request) {
    return yield* Effect.promise(async (): Promise<typeof VaultDatabasesResponse.Type> => {
      try {
        const databases = await listVaultDatabases(request.allowUnlock);
        return { status: "ok", databases, error: null };
      } catch (error) {
        const status = error instanceof VaultError ? error.status : "error";
        return {
          status,
          databases: [],
          error: error instanceof Error ? error.message : String(error),
        };
      }
    });
  }),
});
