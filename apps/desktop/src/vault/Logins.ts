import {
  VaultLoginsResponse,
  type VaultLoginsRequest,
  type VaultFillRequest,
  type VaultFillResult,
  type DesktopCredentialFillResult,
  type CredentialField,
} from "@t3tools/contracts";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { vaultBridgeRequest, VaultError } from "../ipc/methods/vault.ts";

const decodeResponse = Schema.decodeUnknownOption(VaultLoginsResponse);

function httpsOrigin(value: string): string | null {
  try {
    const url = new URL(value);
    return url.protocol === "https:" && !url.username && !url.password ? url.origin : null;
  } catch {
    return null;
  }
}

export async function listVaultLogins(
  request: VaultLoginsRequest,
  send = vaultBridgeRequest,
): Promise<VaultLoginsResponse> {
  if (request.action === "list" && !httpsOrigin(request.url))
    return { status: "ok", items: [], error: null };
  try {
    const reply = await send({
      kind: "login",
      mode: request.action === "status" ? "status" : "list-login",
      ...(request.action === "list" ? { url: request.url } : {}),
      allowUnlock: request.action === "list" && request.allowUnlock,
    });
    if (reply.status === "locked" || reply.status === "cancelled")
      return { status: "locked", items: [], error: null };
    if (reply.status === "unlocked" && request.action === "status")
      return { status: "ok", items: [], error: null };
    if (reply.status !== "suggestions" || !Array.isArray(reply.suggestions))
      return {
        status: "error",
        items: [],
        error: "Vault did not return logins. Update Vault and try again.",
      };
    const decoded = decodeResponse({
      status: "ok",
      items: reply.suggestions.map((item) => ({
        id: item.id.toLowerCase(),
        title: item.name,
        username: item.username || null,
        source: "vault",
      })),
      error: null,
    });
    return Option.getOrElse(decoded, () => ({
      status: "error" as const,
      items: [],
      error: "Vault returned an invalid login list.",
    }));
  } catch (error) {
    return {
      status: error instanceof VaultError ? error.status : "error",
      items: [],
      error:
        error instanceof VaultError && error.status === "unavailable"
          ? "Vault is not installed on this Mac."
          : "Vault could not answer. Open or update Vault and try again.",
    };
  }
}

interface FillTarget {
  page(): Promise<{ readonly available: boolean; readonly url: string | null }>;
  insert(input: {
    field: CredentialField;
    expectedOrigin: string;
    value: string;
  }): Promise<DesktopCredentialFillResult>;
}

/** Reads one selected field locally. The renderer and environment receive only the fill status. */
export async function fillVaultLogin(
  request: VaultFillRequest,
  target: FillTarget,
  send = vaultBridgeRequest,
): Promise<VaultFillResult> {
  try {
    const page = await target.page();
    if (!page.available || !page.url) return { status: "tab_unavailable" };
    if (!httpsOrigin(request.expectedOrigin) || httpsOrigin(page.url) !== request.expectedOrigin)
      return { status: "origin_mismatch" };
    const reply = await send({
      kind: "login",
      mode: "login-credential",
      url: page.url,
      itemID: request.itemId,
      field: request.field,
      allowUnlock: true,
    });
    if (reply.status === "item-not-found") return { status: "item_not_found" };
    if (reply.status === "locked" || reply.status === "cancelled") return { status: "denied" };
    if (
      reply.status !== "ok" ||
      reply.itemID?.toLowerCase() !== request.itemId.toLowerCase() ||
      reply.credential?.mode !== request.field
    )
      return { status: "insert_failed" };
    const value = reply.credential[request.field === "otp" ? "code" : request.field];
    if (typeof value !== "string" || !value) return { status: "no_value" };
    const current = await target.page();
    if (!current.available || !current.url || httpsOrigin(current.url) !== request.expectedOrigin)
      return { status: "origin_mismatch" };
    return await target.insert({
      field: request.field,
      expectedOrigin: request.expectedOrigin,
      value,
    });
  } catch {
    return { status: "provider_unavailable" };
  }
}
