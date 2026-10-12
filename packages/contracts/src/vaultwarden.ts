import * as Schema from "effect/Schema";

const Text = Schema.String.check(Schema.isNonEmpty(), Schema.isMaxLength(4096));
const Id = Schema.String.check(Schema.isPattern(/^[0-9a-f-]{36}$/i));

/** Entered in the desktop settings form; never included in an agent tool or a response. */
export const VaultwardenAccount = Schema.Struct({
  server: Text,
  clientId: Text,
  clientSecret: Text,
  masterPassword: Text,
});
export type VaultwardenAccount = typeof VaultwardenAccount.Type;

export const VaultwardenCollection = Schema.Struct({
  id: Id,
  name: Schema.String,
  organizationId: Id,
  organizationName: Schema.String,
});
export type VaultwardenCollection = typeof VaultwardenCollection.Type;

export const VaultwardenConnection = Schema.Struct({
  server: Schema.String,
  email: Schema.String,
  collection: VaultwardenCollection,
});
export type VaultwardenConnection = typeof VaultwardenConnection.Type;

export const VaultwardenSetupRequest = Schema.Union([
  Schema.Struct({ action: Schema.Literal("status") }),
  Schema.Struct({ action: Schema.Literal("disconnect") }),
  Schema.Struct({ action: Schema.Literal("check"), account: VaultwardenAccount }),
  Schema.Struct({
    action: Schema.Literal("save"),
    account: VaultwardenAccount,
    organizationId: Id,
    collectionId: Id,
  }),
]);
export type VaultwardenSetupRequest = typeof VaultwardenSetupRequest.Type;

export const VaultwardenSetupResponse = Schema.Struct({
  connection: Schema.NullOr(VaultwardenConnection),
  collections: Schema.Array(VaultwardenCollection),
  error: Schema.NullOr(Schema.String),
});
export type VaultwardenSetupResponse = typeof VaultwardenSetupResponse.Type;
