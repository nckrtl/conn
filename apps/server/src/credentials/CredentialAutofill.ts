import {
  CredentialApprovalDecision,
  DEFAULT_SERVER_SETTINGS,
  DesktopCredentialFillResult,
  PreviewAutomationCredentialLockError,
  type CredentialApprovalRequest,
  type CredentialField,
  type CredentialFillStatus,
  type CredentialProviderStatus,
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
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";

import type * as McpInvocationContext from "../mcp/McpInvocationContext.ts";
import * as PreviewAutomationBroker from "../mcp/PreviewAutomationBroker.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as CredentialProvider from "./CredentialProvider.ts";
import * as TestLoginStore from "./TestLoginStore.ts";
import { parseTotpSetup, totpCode } from "./totp.ts";
import {
  matchingOrigin,
  parseSavedUrl,
  requestedHost,
  savedUrlsMatchHost,
} from "./credentialOrigin.ts";

/** The desktop denies at its own deadline first, so the broker never times out a live host. */
const APPROVAL_BROKER_MARGIN_MS = 15_000;
/** How long one sign-in approval covers the login's other fields. */
const SIGN_IN_GRANT_SECONDS = 60;
const SIGN_IN_FIELDS: ReadonlyArray<CredentialField> = ["username", "password", "otp"];

const decodeDecision = Schema.decodeUnknownOption(CredentialApprovalDecision);
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

/** The page a secret went into, as the tab reported it at fill time. */
interface ScriptLock {
  /** Absent when the desktop host predates document ids. */
  readonly documentId: number | undefined;
  readonly url: string;
}

const withoutHash = (url: string) => url.split("#", 1)[0];

/**
 * Whether the tab still shows the locked document. A document id says so
 * exactly: it survives hash and pushState changes, and a reload gets a new one.
 * Without ids, the URL minus its hash is the best guess, and a pushState
 * change then releases the lock.
 */
const showsLockedDocument = (lock: ScriptLock, page: PreviewAutomationStatus) =>
  lock.documentId !== undefined && page.documentId !== undefined
    ? lock.documentId === page.documentId
    : page.url !== null && withoutHash(page.url) === withoutHash(lock.url);

interface SignInGrant {
  readonly fields: ReadonlySet<CredentialField>;
  readonly expiresAt: number;
}

const tabKey = (scope: McpInvocationContext.McpInvocationScope, tabId: PreviewTabId) =>
  `${scope.environmentId}\u0000${scope.threadId}\u0000${tabId}`;

export class CredentialAutofill extends Context.Service<
  CredentialAutofill,
  {
    /** Whether the password manager is reachable, for Settings. */
    readonly status: Effect.Effect<CredentialProviderStatus>;
    /** Saved logins for a site, as metadata only. */
    readonly request: (
      input: RequestCredentialsInput,
    ) => Effect.Effect<
      RequestCredentialsResult,
      CredentialProvider.CredentialProviderUnavailableError
    >;
    /**
     * Checks the tab's origin against the item, asks the user (or uses a
     * live sign-in approval), then has the desktop insert the value. Returns
     * a status only, never the value.
     */
    readonly fill: (
      scope: McpInvocationContext.McpInvocationScope,
      input: FillCredentialInput,
    ) => Effect.Effect<FillCredentialResult, PreviewAutomationError>;
    /** Saved logins for the page the user is on, for the browser's key menu. */
    readonly listForSite: (
      input: ListSiteCredentialsInput,
    ) => Effect.Effect<ListSiteCredentialsResult>;
    /**
     * Fills fields the user picked in the browser's key menu. No prompt: the
     * user asked in that browser, and the value only goes to the host that sent it.
     */
    readonly fillForSite: (
      input: FillSiteCredentialInput,
    ) => Effect.Effect<FillSiteCredentialResult, PreviewAutomationError>;
    /** Saves a test user an agent created, in T3 Code's own test-login store. */
    readonly saveTestLogin: (
      input: SaveTestLoginInput,
    ) => Effect.Effect<TestLoginSummary, TestLoginStoreError>;
    /**
     * Whether the tab still shows the document a password or code was filled
     * into. Releases the lock once the tab loads another document.
     */
    readonly isScriptLocked: (
      scope: McpInvocationContext.McpInvocationScope,
      tabId: PreviewTabId | undefined,
    ) => Effect.Effect<boolean, PreviewAutomationError>;
    /** Fails when agent JavaScript would run in a tab that `isScriptLocked`. */
    readonly guardScript: (
      scope: McpInvocationContext.McpInvocationScope,
      tabId: PreviewTabId | undefined,
    ) => Effect.Effect<void, PreviewAutomationError>;
  }
>()("t3/credentials/CredentialAutofill") {}

const make = Effect.gen(function* () {
  const provider = yield* CredentialProvider.CredentialProvider;
  const testLogins = yield* TestLoginStore.TestLoginStore;
  const broker = yield* PreviewAutomationBroker.PreviewAutomationBroker;
  const serverSettings = yield* ServerSettings.ServerSettingsService;
  const grants = yield* Ref.make<ReadonlyMap<string, SignInGrant>>(new Map());
  /** Tab key → the document a secret was filled into. */
  const locks = yield* Ref.make<ReadonlyMap<string, ScriptLock>>(new Map());

  const settings = serverSettings.getSettings.pipe(
    Effect.map((current) => current.credentialAutofill),
    Effect.orElseSucceed(() => DEFAULT_SERVER_SETTINGS.credentialAutofill),
  );

  const testLoginsAsCredentials = testLogins.list.pipe(
    Effect.map((stored) =>
      stored.map((login): CredentialProvider.CredentialLogin => ({
        id: login.id,
        title: login.label || login.username,
        vaultId: "",
        urls: [login.url],
        username: login.username,
        source: "test",
      })),
    ),
    // A broken test store must not take 1Password down with it.
    Effect.orElseSucceed((): ReadonlyArray<CredentialProvider.CredentialLogin> => []),
  );

  /** Test logins first, then 1Password's. A 1Password failure leaves test logins usable. */
  const allLogins = Effect.gen(function* () {
    const test = yield* testLoginsAsCredentials;
    const onePassword = yield* provider.listLogins.pipe(Effect.result);
    return onePassword._tag === "Failure"
      ? { logins: test, onePasswordError: onePassword.failure }
      : { logins: [...test, ...onePassword.success], onePasswordError: null };
  });

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

  const readSecret = (
    login: CredentialProvider.CredentialLogin,
    field: CredentialField,
  ): Effect.Effect<
    Option.Option<Redacted.Redacted<string>>,
    CredentialProvider.CredentialProviderUnavailableError | TestLoginStoreError
  > =>
    login.source === "test" ? readTestSecret(login.id, field) : provider.readSecret(login, field);

  const request: CredentialAutofill["Service"]["request"] = Effect.fn("CredentialAutofill.request")(
    function* (input) {
      const host = requestedHost(input.domain);
      if (!host) return { items: [] };
      const { logins, onePasswordError } = yield* allLogins;
      const matches = logins.filter((login) => savedUrlsMatchHost(login.urls, host));
      if (matches.length === 0 && onePasswordError) return yield* onePasswordError;
      return {
        items: matches.map((login) => ({
          id: login.id,
          title: login.title,
          urls: login.urls,
          source: login.source,
          // Agents may see test usernames; 1Password's stay with the user.
          ...(login.source === "test" && login.username ? { username: login.username } : {}),
        })),
      };
    },
  );

  const fill: CredentialAutofill["Service"]["fill"] = Effect.fn("CredentialAutofill.fill")(
    function* (scope, input) {
      const options = yield* settings;
      const { logins, onePasswordError } = yield* allLogins;
      const login = logins.find((candidate) => candidate.id === input.itemId);
      if (!login) {
        return onePasswordError
          ? result("provider_unavailable", onePasswordError.message)
          : result("item_not_found");
      }
      // Test logins are for sites you develop: no prompt and no script lock.
      const isTest = login.source === "test";

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

      // A sign-in approval is bound to this agent session, tab, login and origin.
      const grantKey = `${tabKey(scope, tabId)}\u0000${scope.providerSessionId}\u0000${login.id}\u0000${origin}`;
      const now = yield* Clock.currentTimeMillis;
      const grant = (yield* Ref.get(grants)).get(grantKey);
      const granted =
        isTest || (grant !== undefined && grant.expiresAt > now && grant.fields.has(input.field));
      if (!granted) {
        const approvalRequest: CredentialApprovalRequest = {
          itemTitle: login.title,
          providerLabel: provider.label,
          origin,
          field: input.field,
          timeoutSeconds: options.approvalTimeoutSeconds,
          fieldExpression,
          ...(options.oneApprovalPerSignIn
            ? { signInFields: SIGN_IN_FIELDS, signInSeconds: SIGN_IN_GRANT_SECONDS }
            : {}),
        };
        const answer = yield* broker.invoke<unknown>({
          scope,
          operation: "credentialApproval",
          input: approvalRequest,
          tabId,
          timeoutMs: options.approvalTimeoutSeconds * 1000 + APPROVAL_BROKER_MARGIN_MS,
          updateCurrentTab: false,
        });
        const decision = Option.getOrUndefined(decodeDecision(answer));
        const allowed = options.oneApprovalPerSignIn
          ? (decision?.fields ?? []).filter((field) => SIGN_IN_FIELDS.includes(field))
          : [input.field];
        if (decision?.approved !== true || !allowed.includes(input.field)) {
          return result("denied");
        }
        if (options.oneApprovalPerSignIn) {
          const expiresAt = (yield* Clock.currentTimeMillis) + SIGN_IN_GRANT_SECONDS * 1000;
          yield* Ref.update(grants, (current) => {
            const next = new Map([...current].filter(([, entry]) => entry.expiresAt > now));
            next.set(grantKey, { fields: new Set(allowed), expiresAt });
            return next;
          });
        }
      }

      return yield* readAndFill({
        scope,
        login,
        field: input.field,
        tabId,
        origin,
        pageUrl: page.url,
        fieldExpression,
        blockScripts: options.blockScriptsAfterFill && !isTest,
      });
    },
  );

  /** Reads one value and has the desktop insert it. Never returns the value. */
  const readAndFill = Effect.fn("CredentialAutofill.readAndFill")(function* (step: {
    readonly scope: McpInvocationContext.McpInvocationScope;
    readonly login: CredentialProvider.CredentialLogin;
    readonly field: CredentialField;
    readonly tabId: PreviewTabId;
    readonly origin: string;
    readonly pageUrl: string;
    readonly fieldExpression: string;
    readonly blockScripts: boolean;
    readonly clientId?: string;
  }) {
    const secret = yield* readSecret(step.login, step.field).pipe(Effect.result);
    if (secret._tag === "Failure") return result("provider_unavailable", secret.failure.message);
    if (Option.isNone(secret.success)) return result("no_value");

    const filled = yield* broker.invoke<unknown>({
      scope: step.scope,
      operation: "credentialFill",
      input: {
        field: step.field,
        expectedOrigin: step.origin,
        fieldExpression: step.fieldExpression,
        value: Redacted.value(secret.success.value),
      },
      tabId: step.tabId,
      updateCurrentTab: false,
      ...(step.clientId === undefined ? {} : { clientId: step.clientId }),
    });
    const outcome = Option.getOrUndefined(decodeFillResult(filled));
    const status = outcome?.status ?? "insert_failed";
    if (status === "filled" && step.field !== "username" && step.blockScripts) {
      const lock: ScriptLock = { documentId: outcome?.documentId, url: step.pageUrl };
      yield* Ref.update(locks, (current) =>
        new Map(current).set(tabKey(step.scope, step.tabId), lock),
      );
    }
    return result(status);
  });

  const listForSite: CredentialAutofill["Service"]["listForSite"] = Effect.fn(
    "CredentialAutofill.listForSite",
  )(function* (input) {
    const options = yield* settings;
    const { logins, onePasswordError } = yield* allLogins;
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
      unavailable: onePasswordError?.message ?? null,
    };
  });

  const fillForSite: CredentialAutofill["Service"]["fillForSite"] = Effect.fn(
    "CredentialAutofill.fillForSite",
  )(function* (input) {
    const options = yield* settings;
    const scope: McpInvocationContext.McpInvocationScope = {
      environmentId: input.environmentId,
      threadId: input.threadId,
      providerSessionId: `user:${input.hostClientId}`,
      providerInstanceId: ProviderInstanceId.make("user"),
      capabilities: new Set(["preview"]),
      issuedAt: 0,
    };
    const every = (status: CredentialFillStatus) => ({
      results: input.fields.map((field) => ({ field, status })),
    });
    const { logins, onePasswordError } = yield* allLogins;
    const login = logins.find((candidate) => candidate.id === input.itemId);
    if (!login) return every(onePasswordError ? "provider_unavailable" : "item_not_found");
    const page = yield* broker.invoke<PreviewAutomationStatus>({
      scope,
      operation: "status",
      input: {},
      tabId: input.tabId,
      clientId: input.hostClientId,
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
        pageUrl: page.url,
        fieldExpression: credentialFieldExpression(field),
        blockScripts: options.blockScriptsAfterFill && login.source !== "test",
        clientId: input.hostClientId,
      });
      results.push({ field, status: filled.status });
    }
    return { results };
  });

  /** The tab that still shows a filled document, or null. Drops locks of documents that are gone. */
  const lockedTab = Effect.fn("CredentialAutofill.lockedTab")(function* (
    scope: McpInvocationContext.McpInvocationScope,
    tabId: PreviewTabId | undefined,
  ) {
    const threadPrefix = `${scope.environmentId}\u0000${scope.threadId}\u0000`;
    const current = yield* Ref.get(locks);
    if (![...current.keys()].some((key) => key.startsWith(threadPrefix))) return null;
    const page = yield* broker.invoke<PreviewAutomationStatus>({
      scope,
      operation: "status",
      input: {},
      updateCurrentTab: false,
      ...(tabId === undefined ? {} : { tabId }),
    });
    if (!page.tabId) return null;
    const key = tabKey(scope, page.tabId);
    const lock = current.get(key);
    if (lock === undefined) return null;
    if (showsLockedDocument(lock, page)) return page.tabId;
    // A different document is loaded, so the filled input is gone.
    yield* Ref.update(locks, (latest) => {
      const next = new Map(latest);
      next.delete(key);
      return next;
    });
    return null;
  });

  const isScriptLocked: CredentialAutofill["Service"]["isScriptLocked"] = (scope, tabId) =>
    lockedTab(scope, tabId).pipe(Effect.map((locked) => locked !== null));

  const guardScript: CredentialAutofill["Service"]["guardScript"] = Effect.fn(
    "CredentialAutofill.guardScript",
  )(function* (scope, tabId) {
    const locked = yield* lockedTab(scope, tabId);
    if (locked === null) return;
    return yield* new PreviewAutomationCredentialLockError({
      threadId: scope.threadId,
      tabId: locked,
    });
  });

  return CredentialAutofill.of({
    status: provider.status,
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
