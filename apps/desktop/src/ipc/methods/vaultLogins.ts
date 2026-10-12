import {
  VaultLoginsRequest,
  VaultLoginsResponse,
  VaultFillRequest,
  VaultFillResult,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import { credentialFieldExpression } from "@t3tools/shared/credentialFill";
import * as PreviewManager from "../../preview/Manager.ts";
import * as DesktopIpc from "../DesktopIpc.ts";
import { VAULT_LOGINS_CHANNEL, VAULT_FILL_CHANNEL } from "../channels.ts";
import { listVaultLogins, fillVaultLogin } from "../../vault/Logins.ts";

export const vaultLogins = DesktopIpc.makeIpcMethod({
  channel: VAULT_LOGINS_CHANNEL,
  payload: VaultLoginsRequest,
  result: VaultLoginsResponse,
  handler: (request) => Effect.promise(() => listVaultLogins(request)),
});

export const vaultFill = DesktopIpc.makeIpcMethod({
  channel: VAULT_FILL_CHANNEL,
  payload: VaultFillRequest,
  result: VaultFillResult,
  handler: Effect.fn("desktop.ipc.vault.fill")(function* (request) {
    const manager = yield* PreviewManager.PreviewManager;
    const run = Effect.runPromiseWith(yield* Effect.context<never>());
    return yield* Effect.promise(() =>
      fillVaultLogin(request, {
        page: () => run(manager.automationStatus(request.tabId)),
        insert: (input) =>
          run(
            manager.automationFillCredential(request.tabId, {
              ...input,
              value: Redacted.make(input.value),
              fieldExpression: credentialFieldExpression(input.field),
            }),
          ),
      }),
    );
  }),
});
