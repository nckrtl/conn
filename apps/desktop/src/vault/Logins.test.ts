import { describe, expect, it } from "vite-plus/test";
import { listVaultLogins, fillVaultLogin } from "./Logins.ts";
import type { vaultBridgeRequest } from "../ipc/methods/vault.ts";
import type { VaultFillRequest } from "@t3tools/contracts";

const id = "12345678-1234-1234-1234-123456789abc";
const secret = "private-fixture-value";
const request: VaultFillRequest = {
  tabId: "tab",
  itemId: id,
  field: "password",
  expectedOrigin: "https://example.com",
};
const reply = { status: "ok", itemID: id, credential: { mode: "password", password: secret } };

describe("personal Vault website logins", () => {
  it("returns metadata only and keeps passive lookups from unlocking", async () => {
    let unlock: boolean | undefined;
    const send: typeof vaultBridgeRequest = async (input) => {
      unlock = input.allowUnlock;
      return {
        status: "suggestions",
        suggestions: [
          { id: id.toUpperCase(), name: "Example", username: "user", password: secret },
        ],
        credential: reply.credential,
      };
    };
    const result = await listVaultLogins(
      { action: "list", url: "https://example.com/login", allowUnlock: false },
      send,
    );
    expect(result.items).toEqual([{ id, title: "Example", username: "user", source: "vault" }]);
    expect(unlock).toBe(false);
    expect(JSON.stringify(result)).not.toContain(secret);
  });

  it("returns a locked state and unlocks only when explicitly requested", async () => {
    const allow: boolean[] = [];
    const send: typeof vaultBridgeRequest = async (input) => {
      allow.push(input.allowUnlock);
      return { status: "locked" };
    };
    expect((await listVaultLogins({ action: "status" }, send)).status).toBe("locked");
    expect(
      (
        await listVaultLogins(
          { action: "list", url: "https://example.com", allowUnlock: true },
          send,
        )
      ).status,
    ).toBe("locked");
    expect(allow).toEqual([false, true]);
  });

  it.each(["http://example.com", "https://user:pass@example.com", "file:///tmp/login"])(
    "does not query Vault for unsafe URL %s",
    async (url) => {
      let calls = 0;
      const result = await listVaultLogins({ action: "list", url, allowUnlock: true }, async () => {
        calls++;
        return {};
      });
      expect(calls).toBe(0);
      expect(result.items).toEqual([]);
    },
  );

  it("fills the selected field locally and returns only its status", async () => {
    const result = await fillVaultLogin(
      request,
      {
        page: async () => ({ available: true, url: "https://example.com/login" }),
        insert: async (input) => {
          expect(input.value).toBe(secret);
          return { status: "filled", documentId: 7 };
        },
      },
      async (input) => {
        expect(input).toMatchObject({
          kind: "login",
          mode: "login-credential",
          itemID: id,
          field: "password",
          url: "https://example.com/login",
        });
        return reply;
      },
    );
    expect(result).toEqual({ status: "filled", documentId: 7 });
    expect(JSON.stringify(result)).not.toContain(secret);
  });

  it.each([false, true])(
    "refuses navigation to a different origin before or during unlock: %s",
    async (during) => {
      let pages = 0,
        sends = 0,
        fills = 0;
      const result = await fillVaultLogin(
        request,
        {
          page: async () => ({
            available: true,
            url: during && pages++ === 0 ? "https://example.com/login" : "https://other.example",
          }),
          insert: async () => {
            fills++;
            return { status: "filled" };
          },
        },
        async () => {
          sends++;
          return reply;
        },
      );
      expect(result.status).toBe("origin_mismatch");
      expect(fills).toBe(0);
      expect(sends).toBe(during ? 1 : 0);
    },
  );

  it.each([
    { response: { status: "locked" }, status: "denied" },
    { response: { status: "item-not-found" }, status: "item_not_found" },
    { response: { ...reply, itemID: "other" }, status: "insert_failed" },
    {
      response: { ...reply, credential: { mode: "username", username: secret } },
      status: "insert_failed",
    },
    { response: { ...reply, credential: { mode: "password" } }, status: "no_value" },
  ])("refuses unavailable or mismatched credentials: $status", async ({ response, status }) => {
    let fills = 0;
    const result = await fillVaultLogin(
      request,
      {
        page: async () => ({ available: true, url: request.expectedOrigin }),
        insert: async () => {
          fills++;
          return { status: "filled" };
        },
      },
      async () => response,
    );
    expect(result.status).toBe(status);
    expect(fills).toBe(0);
  });

  it("does not expose bridge exception contents", async () => {
    const result = await listVaultLogins({ action: "status" }, async () => {
      throw new Error(secret);
    });
    expect(result.status).toBe("error");
    expect(JSON.stringify(result)).not.toContain(secret);
  });
});
