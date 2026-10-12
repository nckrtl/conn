import * as Effect from "effect/Effect";

import * as CredentialAutofill from "../../../credentials/CredentialAutofill.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";
import * as McpToolAccess from "../../McpToolAccess.ts";
import { CredentialsToolkit } from "./tools.ts";

// Credentials drive the collaborative browser, so they share its capability.
export const layer = McpToolAccess.toLayer(CredentialsToolkit, {
  request_credentials: McpToolAccess.readsAsCaller((input) =>
    Effect.gen(function* () {
      yield* McpInvocationContext.requireThreadMcpCapability("preview");
      const autofill = yield* CredentialAutofill.CredentialAutofill;
      return yield* autofill.request(input);
    }),
  ),
  save_test_login: McpToolAccess.actsAsCaller((input) =>
    Effect.gen(function* () {
      yield* McpInvocationContext.requireThreadMcpCapability("preview");
      const autofill = yield* CredentialAutofill.CredentialAutofill;
      return yield* autofill.saveTestLogin(input);
    }),
  ),
  fill_credential: McpToolAccess.actsAsCaller((input) =>
    Effect.gen(function* () {
      const scope = yield* McpInvocationContext.requireThreadMcpCapability("preview");
      const autofill = yield* CredentialAutofill.CredentialAutofill;
      return yield* autofill.fill(scope, input);
    }),
  ),
});
