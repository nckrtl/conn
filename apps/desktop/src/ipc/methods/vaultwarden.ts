import { VaultwardenSetupRequest, VaultwardenSetupResponse } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as Option from "effect/Option";
import * as Electron from "electron";
import { VaultwardenAccounts, runBitwarden } from "../../vaultwarden/Account.ts";
import * as DesktopIpc from "../DesktopIpc.ts";
import { VAULTWARDEN_SETUP_CHANNEL } from "../channels.ts";

const decodeRequest = Schema.decodeUnknownOption(VaultwardenSetupRequest);

let accounts: Promise<VaultwardenAccounts> | undefined;

export const vaultwardenSetup = DesktopIpc.makeIpcMethod({
  channel: VAULTWARDEN_SETUP_CHANNEL,
  // Decode inside the handler so a validation error cannot include a supplied secret.
  payload: Schema.Unknown,
  result: VaultwardenSetupResponse,
  handler: (raw) =>
    Effect.promise(async () => {
      try {
        const decoded = decodeRequest(raw);
        if (Option.isNone(decoded))
          return {
            connection: null,
            collections: [],
            error: "Enter valid Vaultwarden connection details.",
          };
        accounts ??= import("@napi-rs/keyring").then(
          ({ AsyncEntry }) =>
            new VaultwardenAccounts(
              new AsyncEntry("com.nckrtl.conn.vaultwarden", "dedicated-account"),
              runBitwarden,
              (input, init) =>
                Electron.net.fetch(String(input), { ...init, bypassCustomProtocolHandlers: true }),
            ),
        );
        return await (await accounts).request(decoded.value);
      } catch {
        accounts = undefined;
        return {
          connection: null,
          collections: [],
          error: "The OS credential store is unavailable. Nothing was saved.",
        };
      }
    }),
});
