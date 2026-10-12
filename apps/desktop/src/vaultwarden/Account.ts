// @effect-diagnostics nodeBuiltinImport:off -- Bitwarden's CLI owns encryption and uses an isolated temporary profile.
import * as NodeChildProcess from "node:child_process";
import * as NodeCrypto from "node:crypto";
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodePerfHooks from "node:perf_hooks";
import * as Schema from "effect/Schema";
import {
  VaultwardenAccount,
  VaultwardenConnection,
  type VaultwardenCollection,
  type VaultwardenSetupRequest,
  type VaultwardenSetupResponse,
} from "@t3tools/contracts";

const StoredAccount = Schema.Struct({
  account: VaultwardenAccount,
  connection: VaultwardenConnection,
});
const decodeStored = Schema.decodeUnknownSync(Schema.fromJsonString(StoredAccount));
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface AccountKeychain {
  getPassword(): Promise<string | null | undefined>;
  setPassword(value: string): Promise<void>;
  deleteCredential(): Promise<boolean>;
}

export type RunBitwarden = (
  args: readonly string[],
  environment: Record<string, string>,
) => Promise<string>;

/** Never interpolate a secret into argv or include CLI output in an error. */
export const runBitwarden: RunBitwarden = (args, environment) =>
  new Promise((resolve, reject) => {
    NodeChildProcess.execFile(
      "bw",
      [...args, "--nointeraction"],
      {
        env: environment,
        timeout: 45_000,
        maxBuffer: 4 * 1024 * 1024,
        encoding: "utf8",
      },
      (error, stdout) => {
        if (error) {
          reject(
            new Error(
              "Bitwarden could not complete the request. Check that the bw CLI is installed, the server is trusted and reachable, and the account details are correct.",
            ),
          );
        } else resolve(stdout);
      },
    );
  });

function serverOrigin(value: string): string {
  const url = new URL(value);
  if (
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    url.pathname !== "/" ||
    url.search ||
    url.hash
  ) {
    throw new Error("Use the HTTPS origin of your Vaultwarden server.");
  }
  return url.origin;
}

const CliCollection = Schema.Struct({
  id: Schema.String,
  name: Schema.String,
  organizationId: Schema.String,
});
const PermissionCollection = Schema.Struct({
  id: Schema.String,
  organizationId: Schema.String,
  readOnly: Schema.optional(Schema.Boolean),
  hidePasswords: Schema.optional(Schema.Boolean),
});
const decodeCollections = Schema.decodeUnknownSync(
  Schema.fromJsonString(Schema.Array(CliCollection)),
);

const decodeToken = Schema.decodeUnknownSync(Schema.Struct({ access_token: Schema.String }));
const Profile = Schema.Struct({
  id: Schema.String,
  email: Schema.String,
  organizations: Schema.optional(
    Schema.Array(
      Schema.Struct({
        id: Schema.String,
        name: Schema.String,
        status: Schema.Number,
        enabled: Schema.Boolean,
      }),
    ),
  ),
});
const decodePermissions = Schema.decodeUnknownSync(
  Schema.Struct({ profile: Profile, collections: Schema.Array(PermissionCollection) }),
);

interface CheckedAccount {
  server: string;
  email: string;
  collections: readonly VaultwardenCollection[];
}

function writableCollections(
  collections: readonly VaultwardenCollection[],
  permissions: ReturnType<typeof decodePermissions>,
): VaultwardenCollection[] {
  return collections.filter((collection) => {
    const membership = permissions.profile.organizations?.find(
      (org) => org.id === collection.organizationId,
    );
    const access = permissions.collections.find(
      (entry) => entry.id === collection.id && entry.organizationId === collection.organizationId,
    );
    return (
      membership?.status === 2 &&
      membership.enabled &&
      access?.readOnly === false &&
      access.hidePasswords === false &&
      UUID.test(collection.id) &&
      UUID.test(collection.organizationId)
    );
  });
}

/** Owns only Conn's dedicated account. The user's existing bw profile is never opened. */
export class VaultwardenAccounts {
  private pending: Promise<unknown> = Promise.resolve();
  private readonly checkKey = NodeCrypto.randomBytes(32);
  // Only metadata and a keyed fingerprint survive Check. No password, token, or CLI session.
  private checked: { fingerprint: string; expiresAt: number; value: CheckedAccount } | undefined;
  private readonly keychain: AccountKeychain;
  private readonly run: RunBitwarden;
  private readonly fetcher: typeof fetch;
  private readonly now: () => number;

  constructor(
    keychain: AccountKeychain,
    run: RunBitwarden = runBitwarden,
    fetcher: typeof fetch = fetch,
    now: () => number = () => NodePerfHooks.performance.now(),
  ) {
    this.keychain = keychain;
    this.run = run;
    this.fetcher = fetcher;
    this.now = now;
  }

  private fingerprint(account: VaultwardenAccount): string {
    return NodeCrypto.createHmac("sha256", this.checkKey)
      .update(
        JSON.stringify([
          account.server,
          account.clientId,
          account.clientSecret,
          account.masterPassword,
        ]),
      )
      .digest("hex");
  }

  private async permissions(account: VaultwardenAccount, server: string) {
    const headers = {
      "Bitwarden-Client-Name": "cli",
      "Bitwarden-Client-Version": "2026.6.0",
      "Device-Type": "25",
    };
    const json = async (path: string, init: RequestInit = {}): Promise<unknown> => {
      const response = await this.fetcher(server + path, {
        ...init,
        headers: { ...headers, ...init.headers },
        redirect: "error",
        credentials: "omit",
        signal: AbortSignal.timeout(15_000),
      });
      if (!response.ok || !response.body) throw new Error("Vaultwarden request failed.");
      const reader = response.body.getReader();
      let body = "",
        size = 0;
      const decoder = new TextDecoder();
      try {
        while (true) {
          const chunk = await reader.read();
          if (chunk.done) break;
          size += chunk.value.length;
          if (size > 16 * 1024 * 1024) throw new Error("Vaultwarden reply is too large.");
          body += decoder.decode(chunk.value, { stream: true });
        }
        return JSON.parse(body + decoder.decode());
      } finally {
        await reader.cancel();
      }
    };
    const token = decodeToken(
      await json("/identity/connect/token", {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          grant_type: "client_credentials",
          scope: "api",
          client_id: account.clientId,
          client_secret: account.clientSecret,
          deviceType: "25",
          deviceIdentifier: account.clientId.slice(5),
          deviceName: "Conn",
        }).toString(),
      }),
    );
    const authenticated = { headers: { Authorization: `Bearer ${token.access_token}` } };
    // /api/collections omits access flags in Vaultwarden. Sync includes collectionDetails.
    const { profile, collections } = decodePermissions(
      await json("/api/sync?excludeDomains=true", authenticated),
    );
    if (profile.id.toLowerCase() !== account.clientId.slice(5).toLowerCase())
      throw new Error("Account mismatch.");
    return { profile, collections };
  }

  private async inspect(account: VaultwardenAccount) {
    const server = serverOrigin(account.server);
    if (!account.clientId.startsWith("user.") || !UUID.test(account.clientId.slice(5))) {
      throw new Error("Use the dedicated account's personal API client ID (user.…).");
    }
    const directory = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "conn-vaultwarden-"));
    // No inherited BW_SESSION, injected Node options, or disabled TLS verification.
    const env: Record<string, string> = {
      PATH: [process.env.PATH, "/opt/homebrew/bin", "/usr/local/bin", "/usr/bin", "/bin"]
        .filter(Boolean)
        .join(NodePath.delimiter),
      HOME: NodeOS.homedir(),
      BITWARDENCLI_APPDATA_DIR: directory,
      NODE_USE_SYSTEM_CA: "1",
    };
    for (const name of ["SystemRoot", "TMPDIR", "TEMP"]) {
      if (process.env[name]) env[name] = process.env[name];
    }
    try {
      await this.run(["config", "server", server], env);
      await this.run(["login", "--apikey"], {
        ...env,
        BW_CLIENTID: account.clientId,
        BW_CLIENTSECRET: account.clientSecret,
      });
      const session = (
        await this.run(["unlock", "--passwordenv", "CONN_VAULT_PASSWORD", "--raw"], {
          ...env,
          CONN_VAULT_PASSWORD: account.masterPassword,
        })
      ).trim();
      if (!session || session.length > 4096) throw new Error("Invalid session.");
      const unlocked = { ...env, BW_SESSION: session };
      // Login already performs a full sync. Only collection names require CLI decryption;
      // account identity and organization names are present in the authenticated profile.
      const all = decodeCollections(await this.run(["list", "collections"], unlocked));
      // CLI exports omit permissions. Check the authenticated API before offering destinations.
      const permissions = await this.permissions(account, server);
      const collections: VaultwardenCollection[] = all.flatMap((collection) => {
        const organization = permissions.profile.organizations?.find(
          (org) => org.id === collection.organizationId,
        );
        if (!organization) return [];
        return [
          {
            id: collection.id,
            name: collection.name,
            organizationId: organization.id,
            organizationName: organization.name,
          },
        ];
      });
      return {
        server,
        email: permissions.profile.email,
        collections: writableCollections(collections, permissions),
      };
    } finally {
      // Only the temporary directory created by this operation. It contains the CLI's encrypted cache.
      await NodeFSP.rm(directory, { recursive: true, force: true });
    }
  }

  /** Serializes setup/disconnect across desktop windows; returns metadata only. */
  request(input: VaultwardenSetupRequest): Promise<VaultwardenSetupResponse> {
    const operation = this.pending.then(() => this.perform(input));
    this.pending = operation.catch(() => undefined);
    return operation;
  }

  private async perform(input: VaultwardenSetupRequest): Promise<VaultwardenSetupResponse> {
    try {
      if (input.action === "status") {
        const stored = await this.keychain.getPassword();
        return {
          connection: stored ? decodeStored(stored).connection : null,
          collections: [],
          error: null,
        };
      }
      if (input.action === "disconnect") {
        this.checked = undefined;
        await this.keychain.deleteCredential();
        return { connection: null, collections: [], error: null };
      }
      const fingerprint = this.fingerprint(input.account);
      const recent = this.checked;
      this.checked = undefined;
      let checked: CheckedAccount;
      if (
        input.action === "save" &&
        recent?.fingerprint === fingerprint &&
        recent.expiresAt > this.now()
      ) {
        // Recheck access at save time, without repeating login, password derivation, and decryption.
        const permissions = await this.permissions(input.account, recent.value.server);
        checked = {
          ...recent.value,
          email: permissions.profile.email,
          collections: writableCollections(recent.value.collections, permissions),
        };
      } else {
        checked = await this.inspect(input.account);
      }
      if (input.action === "check") {
        this.checked = { fingerprint, value: checked, expiresAt: this.now() + 5 * 60_000 };
        return { connection: null, collections: checked.collections, error: null };
      }
      const collection = checked.collections.find(
        (value) => value.id === input.collectionId && value.organizationId === input.organizationId,
      );
      if (!collection)
        return {
          connection: null,
          collections: checked.collections,
          error: "Choose a collection that this account can edit and read passwords from.",
        };
      const connection: VaultwardenConnection = {
        server: checked.server,
        email: checked.email,
        collection,
      };
      await this.keychain.setPassword(
        JSON.stringify({ account: { ...input.account, server: checked.server }, connection }),
      );
      return { connection, collections: [], error: null };
    } catch {
      // Keychain and CLI errors can include account data. Never forward them to the renderer or logs.
      return {
        connection: null,
        collections: [],
        error:
          "Could not connect. Check the bw CLI, server certificate, account API key, master password, and Keychain access. Your saved connection was not changed.",
      };
    }
  }
}
