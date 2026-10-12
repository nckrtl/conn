import {
  DEFAULT_SERVER_SETTINGS,
  DesktopCredentialFillResult,
  PreviewAutomationCredentialLockError,
  type CredentialField,
  type CredentialFillStatus,
  type FillCredentialInput,
  type FillSiteCredentialInput,
  type FillSiteCredentialResult,
  type ListSiteCredentialsInput,
  type ListSiteCredentialsResult,
  ProviderInstanceId,
  type FillCredentialResult,
  type PreviewAutomationError,
  type PreviewAutomationStatus,
  type PreviewTabId,
  type RequestCredentialsInput,
  type RequestCredentialsResult,
  type SaveTestLoginInput,
  type TestLoginStoreError,
  type TestLoginSummary,
} from "@t3tools/contracts";
import { credentialFieldExpression } from "@t3tools/shared/credentialFill";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";

import type * as McpInvocationContext from "../mcp/McpInvocationContext.ts";
import * as PreviewAutomationBroker from "../mcp/PreviewAutomationBroker.ts";
import type { CredentialFillRequest, CredentialLockResult } from "../preview/ServerBrowserPage.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as TestLoginStore from "./TestLoginStore.ts";
import { parseTotpSetup, totpCode } from "./totp.ts";
import {
  matchingOrigin,
  parseSavedUrl,
  requestedHost,
  savedUrlsMatchHost,
} from "./credentialOrigin.ts";

const decodeFillResult = Schema.decodeUnknownOption(DesktopCredentialFillResult);

const STATUS_MESSAGES: Record<CredentialFillStatus, string> = {
  filled: "Filled. The value is not shown to you.",
  denied: "The user did not approve this fill. Do not retry unless the user asks.",
  tab_unavailable: "The tab has no page loaded. Open the sign-in page with preview_navigate first.",
  origin_mismatch:
    "The tab's site does not match the item's saved website, so nothing was filled. Navigate to the item's site or ask the user to fix the saved URL.",
  field_not_found:
    "No matching input is visible on the page. Navigate to the sign-in step that shows it, or pass a CSS selector.",
  not_editable: "The input cannot take this value. Passwords only go into masked password inputs.",
  insert_failed: "The page did not accept the value.",
  item_not_found: "No login with this id. Call request_credentials first.",
  no_value: "This item has no value for that field.",
  provider_unavailable: "The password manager is unavailable.",
};

const result = (status: CredentialFillStatus, message = STATUS_MESSAGES[status]) => ({
  status,
  message,
});

export class CredentialAutofill extends Context.Service<
  CredentialAutofill,
  {
    /** Saved logins for a site, as metadata only. */
    readonly request: (
      input: RequestCredentialsInput,
    ) => Effect.Effect<RequestCredentialsResult, TestLoginStoreError>;
    /**
     * Checks the tab's origin against a saved test login, then has the
     * environment's browser insert the value. Returns a status only, never
     * the value.
     */
    readonly fill: (
      scope: McpInvocationContext.McpThreadInvocationScope,
      input: FillCredentialInput,
    ) => Effect.Effect<FillCredentialResult, PreviewAutomationError>;
    /** Saved logins for the page the user is on, for the browser's key menu. */
    readonly listForSite: (
      input: ListSiteCredentialsInput,
    ) => Effect.Effect<ListSiteCredentialsResult>;
    /**
     * Fills test-login fields the user picked in the browser's key menu, with
     * no prompt: the user asked. Vault logins never reach the server; the
     * desktop fills those itself.
     */
    readonly fillForSite: (
      input: FillSiteCredentialInput,
    ) => Effect.Effect<FillSiteCredentialResult, PreviewAutomationError>;
    /** Saves a test user an agent created, in T3 Code's own test-login store. */
    readonly saveTestLogin: (
      input: SaveTestLoginInput,
    ) => Effect.Effect<TestLoginSummary, TestLoginStoreError>;
    /**
     * Whether the tab still shows a document a Vault password or code was
     * filled into. The page carries the mark, so the next document clears it.
     */
    readonly isScriptLocked: (
      scope: McpInvocationContext.McpThreadInvocationScope,
      tabId: PreviewTabId | undefined,
    ) => Effect.Effect<boolean, PreviewAutomationError>;
    /** Fails when agent JavaScript would run in a tab that `isScriptLocked`. */
    readonly guardScript: (
      scope: McpInvocationContext.McpThreadInvocationScope,
      tabId: PreviewTabId | undefined,
    ) => Effect.Effect<void, PreviewAutomationError>;
  }
>()("t3/credentials/CredentialAutofill") {}

interface TestCredential {
  readonly id: string;
  readonly title: string;
  readonly urls: readonly string[];
  readonly username: string;
  readonly source: "test";
}

const make = Effect.gen(function* () {
  const testLogins = yield* TestLoginStore.TestLoginStore;
  const broker = yield* PreviewAutomationBroker.PreviewAutomationBroker;
  const serverSettings = yield* ServerSettings.ServerSettingsService;

  const settings = serverSettings.getSettings.pipe(
    Effect.map((current) => current.credentialAutofill),
    Effect.orElseSucceed(() => DEFAULT_SERVER_SETTINGS.credentialAutofill),
  );

  const testLoginsAsCredentials = testLogins.list.pipe(
    Effect.map((stored) =>
      stored.map((login): TestCredential => ({
        id: login.id,
        title: login.label || login.username,
        urls: [login.url],
        username: login.username,
        source: "test",
      })),
    ),
  );

  const readTestSecret = (id: string, field: CredentialField) =>
    testLogins.list.pipe(
      Effect.flatMap((stored) =>
        Clock.currentTimeMillis.pipe(Effect.map((now) => ({ stored, now }))),
      ),
      Effect.map(({ stored, now }) => {
        const login = stored.find((candidate) => candidate.id === id);
        if (!login) return Option.none<Redacted.Redacted<string>>();
        if (field === "otp") {
          const setup = login.otpSecret ? parseTotpSetup(login.otpSecret) : null;
          return setup ? Option.some(Redacted.make(totpCode(setup, now))) : Option.none();
        }
        const value = field === "username" ? login.username : login.password;
        return value.length > 0 ? Option.some(Redacted.make(value)) : Option.none();
      }),
    );

  const request: CredentialAutofill["Service"]["request"] = Effect.fn("CredentialAutofill.request")(
    function* (input) {
      const host = requestedHost(input.domain);
      if (!host) return { items: [] };
      const logins = yield* testLoginsAsCredentials;
      const matches = logins.filter((login) => savedUrlsMatchHost(login.urls, host));
      return {
        items: matches.map((login) => ({
          id: login.id,
          title: login.title,
          urls: login.urls,
          source: login.source,
          username: login.username,
        })),
      };
    },
  );

  const fill: CredentialAutofill["Service"]["fill"] = Effect.fn("CredentialAutofill.fill")(
    function* (scope, input) {
      const options = yield* settings;
      const loaded = yield* testLoginsAsCredentials.pipe(Effect.result);
      if (loaded._tag === "Failure") return result("provider_unavailable", loaded.failure.message);
      const logins = loaded.success;
      const login = logins.find((candidate) => candidate.id === input.itemId);
      if (!login) return result("item_not_found");
      const page = yield* broker.invoke<PreviewAutomationStatus>({
        scope,
        operation: "status",
        input: {},
        updateCurrentTab: false,
        ...(input.tabId === undefined ? {} : { tabId: input.tabId }),
      });
      if (!page.available || !page.url || !page.tabId) return result("tab_unavailable");
      // Pin every later step to the tab whose origin was checked.
      const tabId = page.tabId;
      const origin = matchingOrigin(login.urls, page.url, {
        allowSubdomains: options.allowSubdomains,
      });
      if (!origin) {
        const savedHosts = login.urls.flatMap((url) => parseSavedUrl(url)?.host ?? []);
        return result(
          "origin_mismatch",
          `${STATUS_MESSAGES.origin_mismatch} Saved for: ${savedHosts.join(", ") || "no website"}.`,
        );
      }
      const fieldExpression = credentialFieldExpression(input.field, input.selector);

      return yield* readAndFill({
        scope,
        login,
        field: input.field,
        tabId,
        origin,
        fieldExpression,
        initiator: "agent",
      });
    },
  );

  /** Reads one value and has the browser insert it. Never returns the value. */
  const readAndFill = Effect.fn("CredentialAutofill.readAndFill")(function* (step: {
    readonly scope: McpInvocationContext.McpThreadInvocationScope;
    readonly login: TestCredential;
    readonly field: CredentialField;
    readonly tabId: PreviewTabId;
    readonly origin: string;
    readonly fieldExpression: string;
    readonly initiator: CredentialFillRequest["initiator"];
  }) {
    const secret = yield* readTestSecret(step.login.id, step.field).pipe(Effect.result);
    if (secret._tag === "Failure") return result("provider_unavailable", secret.failure.message);
    if (Option.isNone(secret.success)) return result("no_value");

    const request: CredentialFillRequest = {
      initiator: step.initiator,
      field: step.field,
      expectedOrigin: step.origin,
      fieldExpression: step.fieldExpression,
      value: Redacted.value(secret.success.value),
    };
    const filled = yield* broker.invoke<unknown>({
      scope: step.scope,
      operation: "credentialFill",
      input: request,
      tabId: step.tabId,
      updateCurrentTab: false,
    });
    const outcome = Option.getOrUndefined(decodeFillResult(filled));
    const status = outcome?.status ?? "insert_failed";
    return result(status);
  });

  const listForSite: CredentialAutofill["Service"]["listForSite"] = Effect.fn(
    "CredentialAutofill.listForSite",
  )(function* (input) {
    const options = yield* settings;
    const loaded = yield* testLoginsAsCredentials.pipe(Effect.result);
    if (loaded._tag === "Failure")
      return { origin: null, items: [], unavailable: loaded.failure.message };
    const logins = loaded.success;
    const matches = logins.flatMap((login) => {
      const origin = matchingOrigin(login.urls, input.url, {
        allowSubdomains: options.allowSubdomains,
      });
      return origin ? [{ origin, login }] : [];
    });
    return {
      origin: matches[0]?.origin ?? null,
      items: matches.map(({ login }) => ({
        id: login.id,
        title: login.title,
        username: login.username,
        source: login.source,
      })),
      unavailable: null,
    };
  });

  const fillForSite: CredentialAutofill["Service"]["fillForSite"] = Effect.fn(
    "CredentialAutofill.fillForSite",
  )(function* (input) {
    const options = yield* settings;
    const scope: McpInvocationContext.McpThreadInvocationScope = {
      environmentId: input.environmentId,
      capabilities: new Set(["preview"]),
      issuedAt: 0,
      requestNamespace: `user:${input.threadId}`,
      thread: {
        threadId: input.threadId,
        providerSessionId: `user:${input.threadId}`,
        providerInstanceId: ProviderInstanceId.make("user"),
      },
      client: undefined,
    };
    const every = (status: CredentialFillStatus) => ({
      results: input.fields.map((field) => ({ field, status })),
    });
    if (input.source === "vault") return every("provider_unavailable");
    const loaded = yield* testLoginsAsCredentials.pipe(Effect.result);
    if (loaded._tag === "Failure") return every("provider_unavailable");
    const logins = loaded.success;
    const login = logins.find((candidate) => candidate.id === input.itemId);
    if (!login) return every("item_not_found");
    const page = yield* broker.invoke<PreviewAutomationStatus>({
      scope,
      operation: "status",
      input: {},
      tabId: input.tabId,
      updateCurrentTab: false,
    });
    if (!page.available || !page.url) return every("tab_unavailable");
    const origin = matchingOrigin(login.urls, page.url, {
      allowSubdomains: options.allowSubdomains,
    });
    if (!origin) return every("origin_mismatch");
    const results: Array<{ field: CredentialField; status: CredentialFillStatus }> = [];
    for (const field of input.fields) {
      const filled = yield* readAndFill({
        scope,
        login,
        field,
        tabId: input.tabId,
        origin,
        fieldExpression: credentialFieldExpression(field),
        initiator: "user",
      });
      results.push({ field, status: filled.status });
    }
    return { results };
  });

  const isScriptLocked: CredentialAutofill["Service"]["isScriptLocked"] = Effect.fn(
    "CredentialAutofill.isScriptLocked",
  )(function* (scope, tabId) {
    const options = yield* settings;
    if (!options.blockScriptsAfterFill) return false;
    const lock = yield* broker.invoke<CredentialLockResult>({
      scope,
      operation: "credentialLock",
      input: {},
      updateCurrentTab: false,
      ...(tabId === undefined ? {} : { tabId }),
    });
    return lock.locked;
  });

  const guardScript: CredentialAutofill["Service"]["guardScript"] = Effect.fn(
    "CredentialAutofill.guardScript",
  )(function* (scope, tabId) {
    const options = yield* settings;
    if (!options.blockScriptsAfterFill) return;
    const lock = yield* broker.invoke<CredentialLockResult>({
      scope,
      operation: "credentialLock",
      input: {},
      updateCurrentTab: false,
      ...(tabId === undefined ? {} : { tabId }),
    });
    if (!lock.locked) return;
    return yield* new PreviewAutomationCredentialLockError({
      threadId: scope.thread.threadId,
      tabId: lock.tabId,
    });
  });

  return CredentialAutofill.of({
    request,
    fill,
    listForSite,
    fillForSite,
    saveTestLogin: (input) => testLogins.save(input, "agent"),
    isScriptLocked,
    guardScript,
  });
});

export const layer = Layer.effect(CredentialAutofill, make);
