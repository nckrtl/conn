import { WS_METHODS } from "@t3tools/contracts";
import { Atom } from "effect/unstable/reactivity";

import type { EnvironmentRegistry } from "../connection/registry.ts";
import { createEnvironmentRpcCommand, createEnvironmentRpcQueryAtomFamily } from "./runtime.ts";

export function createCredentialsEnvironmentAtoms<R, E>(
  runtime: Atom.AtomRuntime<EnvironmentRegistry | R, E>,
) {
  return {
    /** Saved logins for one page origin, for the browser's key menu. */
    listForSite: createEnvironmentRpcQueryAtomFamily(runtime, {
      label: "environment-data:credentials:list-for-site",
      tag: WS_METHODS.credentialsListForSite,
    }),
    /** Fills a login the user picked in the browser's key menu. */
    fillForSite: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:credentials:fill-for-site",
      tag: WS_METHODS.credentialsFillForSite,
    }),
    /** T3 Code's own logins for test users. */
    testLogins: createEnvironmentRpcQueryAtomFamily(runtime, {
      label: "environment-data:credentials:test-logins",
      tag: WS_METHODS.testLoginsList,
    }),
    saveTestLogin: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:credentials:save-test-login",
      tag: WS_METHODS.testLoginsSave,
    }),
    updateTestLogin: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:credentials:update-test-login",
      tag: WS_METHODS.testLoginsUpdate,
    }),
    removeTestLogin: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:credentials:remove-test-login",
      tag: WS_METHODS.testLoginsRemove,
    }),
    revealTestLogin: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:credentials:reveal-test-login",
      tag: WS_METHODS.testLoginsReveal,
    }),
  };
}
