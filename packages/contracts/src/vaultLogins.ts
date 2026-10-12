import * as Schema from "effect/Schema";
import { CredentialField, CredentialItemId, CredentialFillStatus } from "./credentials.ts";

export const VaultLoginsRequest = Schema.Union([
  Schema.Struct({ action: Schema.Literal("status") }),
  Schema.Struct({
    action: Schema.Literal("list"),
    url: Schema.String.check(Schema.isMaxLength(4096)),
    allowUnlock: Schema.Boolean,
  }),
]);
export type VaultLoginsRequest = typeof VaultLoginsRequest.Type;

export const VaultLoginOption = Schema.Struct({
  id: CredentialItemId,
  title: Schema.String,
  username: Schema.NullOr(Schema.String),
  source: Schema.Literal("vault"),
});
export type VaultLoginOption = typeof VaultLoginOption.Type;

export const VaultLoginsResponse = Schema.Struct({
  status: Schema.Literals(["ok", "locked", "unavailable", "error"]),
  items: Schema.Array(VaultLoginOption),
  error: Schema.NullOr(Schema.String),
});
export type VaultLoginsResponse = typeof VaultLoginsResponse.Type;

/** The desktop reads a field from Vault and fills it locally; no secret crosses IPC. */
export const VaultFillRequest = Schema.Struct({
  tabId: Schema.String,
  itemId: CredentialItemId,
  field: CredentialField,
  expectedOrigin: Schema.String,
});
export type VaultFillRequest = typeof VaultFillRequest.Type;

export const VaultFillResult = Schema.Struct({
  status: CredentialFillStatus,
});
export type VaultFillResult = typeof VaultFillResult.Type;
