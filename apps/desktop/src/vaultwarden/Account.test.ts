// @effect-diagnostics nodeBuiltinImport:off -- Checks cleanup of the isolated CLI profile.
import * as NodeFSP from "node:fs/promises";
import { describe, expect, it } from "vite-plus/test";
import { VaultwardenAccounts, type RunBitwarden, type AccountKeychain } from "./Account.ts";

const userId = "00000000-0000-0000-0000-000000000001";
const orgId = "00000000-0000-0000-0000-000000000002";
const collectionId = "00000000-0000-0000-0000-000000000003";
const account = {
  server: "https://vault.example",
  clientId: `user.${userId}`,
  clientSecret: "fixture-api-secret",
  masterPassword: "fixture-master-password",
};
const collection = { id: collectionId, organizationId: orgId, name: "Conn" };
const save = { action: "save", account, organizationId: orgId, collectionId } as const;

function fixture(
  options: {
    readOnly?: boolean;
    hidePasswords?: boolean;
    omitPermissions?: boolean;
    status?: number;
    fail?: boolean;
    wrongUser?: boolean;
    noOrganizations?: boolean;
    disabledOrganization?: boolean;
    now?: () => number;
  } = {},
) {
  let stored: string | undefined;
  const calls: { args: readonly string[]; env: Record<string, string> }[] = [];
  const requests: { url: string; init: RequestInit | undefined }[] = [];
  const keychain: AccountKeychain = {
    getPassword: async () => stored,
    setPassword: async (value) => {
      stored = value;
    },
    deleteCredential: async () => {
      stored = undefined;
      return true;
    },
  };
  const run: RunBitwarden = async (args, env) => {
    calls.push({ args: [...args], env: { ...env } });
    if (options.fail && args[0] === "unlock") throw new Error(account.masterPassword);
    switch (args.join(" ")) {
      case "unlock --passwordenv CONN_VAULT_PASSWORD --raw":
        return "fixture-session-key";
      case "list collections":
        return JSON.stringify([collection]);
      default:
        return "";
    }
  };
  const fetcher: typeof fetch = async (input, init) => {
    const url = String(input);
    requests.push({ url, init });
    if (!url.endsWith("/identity/connect/token") && !url.endsWith("/api/sync?excludeDomains=true"))
      throw new Error("Unexpected endpoint: only sync includes collection permissions.");
    const value = url.endsWith("/identity/connect/token")
      ? { access_token: "fixture-access-token" }
      : {
          profile: {
            id: options.wrongUser ? orgId : userId,
            email: "conn@example.com",
            ...(options.noOrganizations
              ? {}
              : {
                  organizations: [
                    {
                      id: orgId,
                      name: "Conn organization",
                      status: options.status ?? 2,
                      enabled: !options.disabledOrganization,
                    },
                  ],
                }),
          },
          collections: [
            {
              id: collectionId,
              organizationId: orgId,
              ...(options.omitPermissions
                ? {}
                : {
                    readOnly: options.readOnly ?? false,
                    hidePasswords: options.hidePasswords ?? false,
                  }),
            },
          ],
        };
    return new Response(JSON.stringify(value));
  };
  return {
    service: new VaultwardenAccounts(keychain, run, fetcher, options.now),
    keychain,
    calls,
    requests,
    stored: () => stored,
  };
}

describe("dedicated Vaultwarden account setup", () => {
  it("checks the dedicated account without storing it or using the personal CLI profile", async () => {
    const f = fixture();
    const result = await f.service.request({ action: "check", account });
    expect(result.error).toBeNull();
    expect(result.collections).toEqual([{ ...collection, organizationName: "Conn organization" }]);
    expect(f.stored()).toBeUndefined();
    const directory = f.calls[0]!.env.BITWARDENCLI_APPDATA_DIR!;
    expect(f.calls.every((call) => call.env.BITWARDENCLI_APPDATA_DIR === directory)).toBe(true);
    await expect(NodeFSP.stat(directory)).rejects.toMatchObject({ code: "ENOENT" });
    const args = JSON.stringify(f.calls.map((call) => call.args));
    for (const secret of [account.masterPassword, account.clientSecret, "fixture-session-key"])
      expect(args).not.toContain(secret);
    expect(f.calls.find((call) => call.args[0] === "login")?.env.BW_CLIENTSECRET).toBe(
      account.clientSecret,
    );
    expect(f.calls.find((call) => call.args[0] === "unlock")?.env.CONN_VAULT_PASSWORD).toBe(
      account.masterPassword,
    );
    expect(
      f.calls.find((call) => call.args[0] === "list")?.env.CONN_VAULT_PASSWORD,
    ).toBeUndefined();
    expect(f.calls[0]!.env.NODE_TLS_REJECT_UNAUTHORIZED).toBeUndefined();
    expect(f.requests.every((request) => request.init?.redirect === "error")).toBe(true);
    expect(JSON.stringify(result)).not.toContain("fixture-");
  });

  it("saves only after verification, and status never returns stored secrets", async () => {
    const f = fixture();
    const result = await f.service.request(save);
    expect(result.error).toBeNull();
    expect(result.connection?.collection.id).toBe(collectionId);
    expect(JSON.parse(f.stored()!).account).toEqual(account);
    expect(await f.service.request({ action: "status" })).toEqual(result);
    expect(JSON.stringify(result)).not.toContain(account.masterPassword);
    expect(JSON.stringify(result)).not.toContain(account.clientSecret);
    expect(JSON.stringify(result)).not.toContain("fixture-session-key");
  });

  it("reuses a recent account check while fetching fresh permissions before saving", async () => {
    const f = fixture();
    await f.service.request({ action: "check", account });
    const cliCalls = f.calls.length;
    const httpCalls = f.requests.length;
    expect((await f.service.request(save)).error).toBeNull();
    expect(f.calls).toHaveLength(cliCalls);
    expect(f.requests.length).toBeGreaterThan(httpCalls);
    expect(JSON.parse(f.stored()!).account).toEqual(account);
  });

  it("rejects permission revocation between checking and saving", async () => {
    const options = { readOnly: false };
    const f = fixture(options);
    await f.keychain.setPassword("previous-connection");
    await f.service.request({ action: "check", account });
    const cliCalls = f.calls.length;
    options.readOnly = true;
    expect((await f.service.request(save)).error).not.toBeNull();
    expect(f.calls).toHaveLength(cliCalls);
    expect(f.stored()).toBe("previous-connection");
  });

  it.each([
    { server: "https://another.example" },
    { clientId: `user.${orgId}` },
    { clientSecret: "changed-api-secret" },
    { masterPassword: "changed-master-password" },
  ])("fully checks changed account details before saving: %j", async (changed) => {
    const options = { fail: false };
    const f = fixture(options);
    await f.service.request({ action: "check", account });
    const cliCalls = f.calls.length;
    options.fail = true;
    expect(
      (await f.service.request({ ...save, account: { ...account, ...changed } })).error,
    ).not.toBeNull();
    expect(f.calls.length).toBeGreaterThan(cliCalls);
    expect(f.stored()).toBeUndefined();
  });

  it("fully checks expired account verification before saving", async () => {
    let now = 1_000;
    const f = fixture({ now: () => now });
    await f.service.request({ action: "check", account });
    const cliCalls = f.calls.length;
    now = 301_001;
    expect((await f.service.request(save)).error).toBeNull();
    expect(f.calls.length).toBeGreaterThan(cliCalls);
  });

  it("discards recent verification when disconnecting", async () => {
    const f = fixture();
    await f.service.request({ action: "check", account });
    const cliCalls = f.calls.length;
    await f.service.request({ action: "disconnect" });
    expect((await f.service.request(save)).error).toBeNull();
    expect(f.calls.length).toBeGreaterThan(cliCalls);
  });

  it.each([
    { readOnly: true },
    { hidePasswords: true },
    { omitPermissions: true },
    { status: 1 },
    { noOrganizations: true },
    { disabledOrganization: true },
  ])("refuses a collection with insufficient or unconfirmed permissions: %j", async (options) => {
    const f = fixture(options);
    await f.keychain.setPassword("previous-connection");
    expect((await f.service.request(save)).error).not.toBeNull();
    expect(f.stored()).toBe("previous-connection");
  });

  it("rejects a forged destination even when another writable collection exists", async () => {
    const f = fixture();
    const result = await f.service.request({ ...save, organizationId: userId });
    expect(result.error).not.toBeNull();
    expect(f.stored()).toBeUndefined();
  });

  it("redacts failures, preserves the saved account, and removes temporary tokens", async () => {
    const f = fixture({ fail: true });
    await f.keychain.setPassword("previous-connection");
    const result = await f.service.request(save);
    expect(result.error).not.toBeNull();
    expect(JSON.stringify(result)).not.toContain(account.masterPassword);
    expect(f.stored()).toBe("previous-connection");
    await expect(NodeFSP.stat(f.calls[0]!.env.BITWARDENCLI_APPDATA_DIR!)).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it("rejects an account identity mismatch", async () => {
    const f = fixture({ wrongUser: true });
    expect((await f.service.request(save)).error).not.toBeNull();
    expect(f.stored()).toBeUndefined();
    expect(f.requests).toHaveLength(2);
  });

  it.each([
    "http://vault.example",
    "https://user:password@vault.example",
    "https://vault.example/another",
    "https://vault.example?redirect=1",
  ])("refuses unsafe server URLs before sending any credentials: %s", async (server) => {
    const f = fixture();
    expect(
      (await f.service.request({ ...save, account: { ...account, server } })).error,
    ).not.toBeNull();
    expect(f.calls).toHaveLength(0);
    expect(f.requests).toHaveLength(0);
  });

  it("disconnects only local Keychain storage, without deleting remote items", async () => {
    const f = fixture();
    await f.keychain.setPassword("previous-connection");
    expect(await f.service.request({ action: "disconnect" })).toEqual({
      connection: null,
      collections: [],
      error: null,
    });
    expect(f.stored()).toBeUndefined();
    expect(f.calls).toHaveLength(0);
    expect(f.requests).toHaveLength(0);
  });
});
