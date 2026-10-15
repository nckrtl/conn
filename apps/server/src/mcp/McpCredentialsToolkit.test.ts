import * as NodeServices from "@effect/platform-node/NodeServices";
import * as ServerConfig from "../config.ts";
import { describe, expect, it } from "@effect/vitest";
import {
  type CredentialAutofillSettings,
  EnvironmentId,
  PreviewTabId,
  PreviewAutomationExecutionError,
  ProviderInstanceId,
  ThreadId,
  TestLoginStoreError,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import { McpSchema, McpServer } from "effect/ai";

import * as CredentialAutofill from "../credentials/CredentialAutofill.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as TestLoginStore from "../credentials/TestLoginStore.ts";
import * as McpHttpServer from "./McpHttpServer.ts";
import * as McpInvocationContext from "./McpInvocationContext.ts";
import * as McpToolAccessTestkit from "./McpToolAccess.testkit.ts";
import * as PreviewAutomationBroker from "./PreviewAutomationBroker.ts";

const SECRET = "test-password";
const ITEM_ID = "11111111-2222-4333-8444-555555555555";

const invocation = (
  capabilities: ReadonlyArray<McpInvocationContext.McpCapability>,
): McpInvocationContext.McpThreadInvocationScope => ({
  environmentId: EnvironmentId.make("environment-credentials-test"),
  requestNamespace: "provider-session-credentials-test",
  thread: {
    threadId: ThreadId.make("thread-credentials-test"),
    providerSessionId: "provider-session-credentials-test",
    providerInstanceId: ProviderInstanceId.make("codex"),
  },
  client: undefined,
  capabilities: new Set(capabilities),
  issuedAt: 1,
});

const client = McpSchema.McpServerClient.of({
  clientId: 1,
  clientCapabilities: {},
  clientInfo: { name: "mcp-test", version: "1.0.0" },
  protocolVersion: "2025-06-18",
  initializePayload: {
    protocolVersion: "2025-06-18",
    capabilities: {},
    clientInfo: { name: "mcp-test", version: "1.0.0" },
  },
  getClient: Effect.die("unused"),
});

const toJson = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));

interface Scenario {
  readonly tabUrl?: string | null;
  readonly fillFails?: boolean;
  readonly storeFails?: boolean;
  readonly settings?: Partial<CredentialAutofillSettings>;
  readonly testLogins?: ReadonlyArray<TestLoginStore.StoredTestLogin>;
}

const TEST_LOGIN_ID = "11111111-2222-4333-8444-555555555555";
const testLogin = (
  overrides: Partial<TestLoginStore.StoredTestLogin> = {},
): TestLoginStore.StoredTestLogin => ({
  id: TEST_LOGIN_ID,
  label: "admin",
  url: "https://github.com/login",
  username: "admin@myapp.test",
  password: "test-password",
  otpSecret: null,
  createdAt: "2026-10-08T00:00:00.000Z",
  createdBy: "user",
  ...overrides,
});

const makeHarness = (scenario: Scenario = {}) => {
  const brokerCalls: Array<{
    operation: string;
    input: unknown;
    tabId?: string;
  }> = [];
  const savedTestLogins: Array<TestLoginStore.StoredTestLogin> = [
    ...(scenario.testLogins ?? [testLogin()]),
  ];
  const testLoginStore = Layer.mock(TestLoginStore.TestLoginStore)({
    list: scenario.storeFails
      ? Effect.fail(new TestLoginStoreError({}))
      : Effect.sync(() => [...savedTestLogins]),
    save: (input, createdBy) =>
      Effect.sync(() => {
        const login = testLogin({
          id: "99999999-2222-4333-8444-555555555555",
          label: input.label ?? "",
          url: input.url,
          username: input.username,
          password: input.password,
          otpSecret: input.otpSecret ?? null,
          createdBy,
        });
        savedTestLogins.push(login);
        return TestLoginStore.summarizeTestLogin(login);
      }),
  });
  /** What the tab shows now; `locked` is the page's mark of a filled Vault secret. */
  const page = {
    url: scenario.tabUrl === undefined ? "https://github.com/login" : scenario.tabUrl,
    locked: false,
  };
  const broker = Layer.mock(PreviewAutomationBroker.PreviewAutomationBroker)({
    invoke: <A>(request: PreviewAutomationBroker.PreviewAutomationInvokeInput) => {
      brokerCalls.push({
        operation: request.operation,
        input: request.input,
        ...(request.tabId === undefined ? {} : { tabId: request.tabId }),
      });
      switch (request.operation) {
        case "status": {
          return Effect.succeed({
            available: page.url !== null,
            visible: true,
            tabId: "tab-1",
            url: page.url,
            title: "Sign in",
            loading: false,
          } as A);
        }
        case "credentialLock":
          return Effect.succeed({ tabId: "tab-1", locked: page.locked } as A);
        case "credentialFill":
          return scenario.fillFails
            ? Effect.fail(
                new PreviewAutomationExecutionError({
                  operation: "credentialFill",
                  environmentId: request.scope.environmentId,
                  threadId: request.scope.thread.threadId,
                  providerSessionId: request.scope.thread.providerSessionId,
                  providerInstanceId: request.scope.thread.providerInstanceId,
                  clientId: "client",
                  connectionId: "connection",
                  requestId: "preview-1",
                  timeoutMs: 15_000,
                  remoteTag: "PreviewAutomationExecutionError",
                  remoteMessageLength: 0,
                  cause: null,
                }),
              )
            : Effect.succeed({ status: "filled" } as A);
        default:
          return Effect.die(`unexpected operation ${request.operation}`);
      }
    },
  });
  const layer = Layer.merge(
    McpHttpServer.layerCredentialsToolkit,
    McpHttpServer.layerPreviewToolkit,
  ).pipe(
    Layer.provideMerge(McpServer.McpServer.layer),
    Layer.provideMerge(McpToolAccessTestkit.liveThreadsLayer),
    Layer.provideMerge(CredentialAutofill.layer),
    Layer.provide(broker),
    Layer.provide(ServerSettings.layerTest({ credentialAutofill: scenario.settings ?? {} })),
    Layer.provide(testLoginStore),
    Layer.provide(
      ServerConfig.layerTest(process.cwd(), { prefix: "t3-credentials-toolkit-test-" }),
    ),
    Layer.provide(NodeServices.layer),
  );
  const call = (name: string, args: Record<string, unknown>, capabilities = ["preview"] as const) =>
    Effect.gen(function* () {
      const server = yield* McpServer.McpServer;
      return yield* server
        .callTool({ name, arguments: args })
        .pipe(
          Effect.provideService(
            McpInvocationContext.McpInvocationContext,
            invocation(capabilities),
          ),
          Effect.provideService(McpSchema.McpServerClient, client),
        );
    });
  const scope = invocation(["preview"]);
  return { brokerCalls, layer, call, scope, savedTestLogins, page };
};

const fillForUser = (
  harness: ReturnType<typeof makeHarness>,
  input: {
    readonly itemId: string;
    readonly fields: ReadonlyArray<"username" | "password" | "otp">;
  },
  source?: "test" | "vault",
) =>
  Effect.gen(function* () {
    const autofill = yield* CredentialAutofill.CredentialAutofill;
    return yield* autofill.fillForSite({
      environmentId: harness.scope.environmentId,
      threadId: harness.scope.thread.threadId,
      tabId: PreviewTabId.make("tab-1"),
      itemId: input.itemId,
      fields: [...input.fields],
      ...(source === undefined ? {} : { source }),
    });
  });

describe("credentials MCP tools", () => {
  it.effect("lists matching logins as metadata without revealing fields", () => {
    const harness = makeHarness();
    return Effect.gen(function* () {
      const server = yield* McpServer.McpServer;
      expect(
        server.tools
          .filter(({ tool }) =>
            ["fill_credential", "request_credentials", "save_test_login"].includes(tool.name),
          )
          .map(({ tool }) => tool.name)
          .toSorted(),
      ).toEqual(["fill_credential", "request_credentials", "save_test_login"]);
      const result = yield* harness.call("request_credentials", { domain: "github.com" });
      expect(result.isError).toBe(false);
      expect(result.structuredContent).toEqual({
        items: [
          {
            id: ITEM_ID,
            title: "admin",
            urls: ["https://github.com/login"],
            source: "test",
            username: "admin@myapp.test",
          },
        ],
      });
    }).pipe(Effect.scoped, Effect.provide(harness.layer));
  });

  it.effect("refuses another origin without asking the user or reading a secret", () => {
    const harness = makeHarness({ tabUrl: "https://github.com.evil.example/login" });
    return Effect.gen(function* () {
      const result = yield* harness.call("fill_credential", { itemId: ITEM_ID, field: "password" });
      expect(result.structuredContent).toMatchObject({ status: "origin_mismatch" });
      expect(harness.brokerCalls.map((entry) => entry.operation)).toEqual(["status"]);
    }).pipe(Effect.scoped, Effect.provide(harness.layer));
  });

  it.effect("reports a tab without a page", () => {
    const harness = makeHarness({ tabUrl: null });
    return Effect.gen(function* () {
      const result = yield* harness.call("fill_credential", { itemId: ITEM_ID, field: "username" });
      expect(result.structuredContent).toMatchObject({ status: "tab_unavailable" });
    }).pipe(Effect.scoped, Effect.provide(harness.layer));
  });

  it.effect("keeps the secret out of a failed fill's error", () => {
    const harness = makeHarness({ fillFails: true });
    return Effect.gen(function* () {
      const result = yield* harness.call("fill_credential", { itemId: ITEM_ID, field: "password" });
      expect(result.isError).toBe(true);
      expect(toJson(result)).not.toContain(SECRET);
    }).pipe(Effect.scoped, Effect.provide(harness.layer));
  });

  it.effect("rejects unknown items and missing browser access", () => {
    const harness = makeHarness();
    return Effect.gen(function* () {
      const unknown = yield* harness.call("fill_credential", {
        itemId: "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee",
        field: "password",
      });
      expect(unknown.structuredContent).toMatchObject({ status: "item_not_found" });
      const denied = yield* harness.call(
        "fill_credential",
        { itemId: ITEM_ID, field: "password" },
        [] as never,
      );
      expect(denied.isError).toBe(true);
    }).pipe(Effect.scoped, Effect.provide(harness.layer));
  });

  it.effect("fills a subdomain only when the setting allows it", () => {
    const strict = makeHarness({ tabUrl: "https://login.github.com/session" });
    const loose = makeHarness({
      tabUrl: "https://login.github.com/session",
      settings: { allowSubdomains: true },
    });
    return Effect.gen(function* () {
      const refused = yield* strict
        .call("fill_credential", { itemId: ITEM_ID, field: "password" })
        .pipe(Effect.provide(strict.layer));
      expect(refused.structuredContent).toMatchObject({ status: "origin_mismatch" });
      const filled = yield* loose
        .call("fill_credential", { itemId: ITEM_ID, field: "password" })
        .pipe(Effect.provide(loose.layer));
      expect(filled.structuredContent).toMatchObject({ status: "filled" });
    }).pipe(Effect.scoped);
  });

  it.effect(
    "blocks agent scripts and screenshots while the page holds a filled Vault secret",
    () => {
      const harness = makeHarness();
      return Effect.gen(function* () {
        const autofill = yield* CredentialAutofill.CredentialAutofill;
        yield* autofill.guardScript(harness.scope, undefined);
        expect(yield* autofill.isScriptLocked(harness.scope, undefined)).toBe(false);
        // The desktop marked the document when it filled the Vault password.
        harness.page.locked = true;
        expect(yield* autofill.isScriptLocked(harness.scope, undefined)).toBe(true);
        const blocked = yield* autofill.guardScript(harness.scope, undefined).pipe(Effect.result);
        expect(blocked._tag).toBe("Failure");
        if (blocked._tag === "Failure") {
          expect(blocked.failure._tag).toBe("PreviewAutomationCredentialLockError");
        }
        // A new document starts without the mark.
        harness.page.locked = false;
        yield* autofill.guardScript(harness.scope, undefined);
      }).pipe(Effect.scoped, Effect.provide(harness.layer));
    },
  );

  it.effect(
    "refuses preview evaluate and CDP endpoint tools on a Vault-locked desktop document",
    () => {
      const harness = makeHarness();
      return Effect.gen(function* () {
        harness.page.locked = true;
        for (const [name, args] of [
          ["preview_evaluate", { expression: "document.title", tabId: "tab-1" }],
          ["preview_cdp_endpoint", { tabId: "tab-1" }],
        ] as const) {
          const result = yield* harness.call(name, args);
          expect(result.isError).toBe(true);
          expect(toJson(result)).toContain("JavaScript is blocked in this tab");
        }
        expect(harness.brokerCalls.map((call) => call.operation)).toEqual([
          "credentialLock",
          "credentialLock",
        ]);
      }).pipe(Effect.scoped, Effect.provide(harness.layer));
    },
  );

  it.effect("does not ask the tab when script blocking is off", () => {
    const harness = makeHarness({ settings: { blockScriptsAfterFill: false } });
    return Effect.gen(function* () {
      const autofill = yield* CredentialAutofill.CredentialAutofill;
      harness.page.locked = true;
      yield* autofill.guardScript(harness.scope, undefined);
      expect(yield* autofill.isScriptLocked(harness.scope, undefined)).toBe(false);
      expect(harness.brokerCalls).toEqual([]);
    }).pipe(Effect.scoped, Effect.provide(harness.layer));
  });

  it.effect("lists the site's logins with username hints for the user's key menu", () => {
    const harness = makeHarness();
    return Effect.gen(function* () {
      const autofill = yield* CredentialAutofill.CredentialAutofill;
      const site = yield* autofill.listForSite({ url: "https://github.com/login?return_to=/" });
      expect(site).toEqual({
        origin: "https://github.com",
        items: [{ id: ITEM_ID, title: "admin", username: "admin@myapp.test", source: "test" }],
        unavailable: null,
      });
      const other = yield* autofill.listForSite({ url: "https://example.org/" });
      expect(other).toEqual({ origin: null, items: [], unavailable: null });
    }).pipe(Effect.scoped, Effect.provide(harness.layer));
  });

  it.effect("fills a test login the user picked without a prompt", () => {
    const harness = makeHarness();
    return Effect.gen(function* () {
      const filled = yield* fillForUser(harness, {
        itemId: ITEM_ID,
        fields: ["username", "password"],
      });
      expect(filled.results).toEqual([
        { field: "username", status: "filled" },
        { field: "password", status: "filled" },
      ]);
      expect(harness.brokerCalls.map((entry) => entry.operation)).toEqual([
        "status",
        "credentialFill",
        "credentialFill",
      ]);
      // It runs as the user's own pick, not as an agent action.
      expect(harness.brokerCalls[1]?.input).toMatchObject({ initiator: "user", field: "username" });
      expect(harness.brokerCalls.every((entry) => entry.tabId === "tab-1")).toBe(true);
    }).pipe(Effect.scoped, Effect.provide(harness.layer));
  });

  it.effect("refuses a user fill on another site without reading a secret", () => {
    const harness = makeHarness({ tabUrl: "https://gitlab.com/users/sign_in" });
    return Effect.gen(function* () {
      const filled = yield* fillForUser(harness, { itemId: ITEM_ID, fields: ["password"] });
      expect(filled.results).toEqual([{ field: "password", status: "origin_mismatch" }]);
      expect(harness.brokerCalls.map((entry) => entry.operation)).toEqual(["status"]);
    }).pipe(Effect.scoped, Effect.provide(harness.layer));
  });

  it.effect("never fills a Vault login: the desktop does that itself", () => {
    const harness = makeHarness();
    return Effect.gen(function* () {
      const filled = yield* fillForUser(
        harness,
        { itemId: TEST_LOGIN_ID, fields: ["password"] },
        "vault",
      );
      expect(filled.results).toEqual([{ field: "password", status: "provider_unavailable" }]);
      expect(harness.brokerCalls).toEqual([]);
    }).pipe(Effect.scoped, Effect.provide(harness.layer));
  });

  it.effect("fills a test login without a prompt or script lock", () => {
    const harness = makeHarness({ testLogins: [testLogin()] });
    return Effect.gen(function* () {
      const found = yield* harness.call("request_credentials", { domain: "github.com" });
      expect(found.structuredContent).toMatchObject({
        items: [{ id: TEST_LOGIN_ID, source: "test", username: "admin@myapp.test" }],
      });
      expect(toJson(found)).not.toContain(SECRET);

      const filled = yield* harness.call("fill_credential", {
        itemId: TEST_LOGIN_ID,
        field: "password",
      });
      expect(filled.structuredContent).toMatchObject({ status: "filled" });
      expect(harness.brokerCalls.map((entry) => entry.operation)).toEqual([
        "status",
        "credentialFill",
      ]);
      expect(harness.brokerCalls[1]!.input).toMatchObject({
        initiator: "agent",
        value: "test-password",
      });
      const autofill = yield* CredentialAutofill.CredentialAutofill;
      yield* autofill.guardScript(harness.scope, undefined);
    }).pipe(Effect.scoped, Effect.provide(harness.layer));
  });

  it.effect("generates the one-time code of a test login", () => {
    const harness = makeHarness({
      testLogins: [testLogin({ otpSecret: "GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ" })],
    });
    return Effect.gen(function* () {
      const filled = yield* harness.call("fill_credential", {
        itemId: TEST_LOGIN_ID,
        field: "otp",
      });
      expect(filled.structuredContent).toMatchObject({ status: "filled" });
      const fill = harness.brokerCalls.find((entry) => entry.operation === "credentialFill");
      expect((fill!.input as { value: string }).value).toMatch(/^\d{6}$/);
    }).pipe(Effect.scoped, Effect.provide(harness.layer));
  });

  it.effect("lets agents save the test users they create", () => {
    const harness = makeHarness({ testLogins: [] });
    return Effect.gen(function* () {
      const saved = yield* harness.call("save_test_login", {
        url: "http://myapp.test/login",
        username: "customer@myapp.test",
        password: "secret-for-test",
        label: "customer",
      });
      expect(saved.isError).toBe(false);
      expect(saved.structuredContent).toMatchObject({ username: "customer@myapp.test" });
      expect(toJson(saved.structuredContent)).not.toContain("secret-for-test");
      expect(harness.savedTestLogins.map((login) => login.createdBy)).toEqual(["agent"]);
    }).pipe(Effect.scoped, Effect.provide(harness.layer));
  });

  it.effect("reports test store failures without offering stale logins", () => {
    const harness = makeHarness({ storeFails: true });
    return Effect.gen(function* () {
      const autofill = yield* CredentialAutofill.CredentialAutofill;
      const site = yield* autofill.listForSite({ url: "https://github.com/login" });
      expect(site.items).toEqual([]);
      expect(site.unavailable).not.toBeNull();
      const found = yield* harness.call("request_credentials", { domain: "github.com" });
      expect(found.isError).toBe(true);
      const filled = yield* harness.call("fill_credential", { itemId: ITEM_ID, field: "password" });
      expect(filled.structuredContent).toMatchObject({ status: "provider_unavailable" });
      expect(harness.brokerCalls).toEqual([]);
    }).pipe(Effect.scoped, Effect.provide(harness.layer));
  });

  it.effect("does not expose personal Vault entries through agent tools", () => {
    const harness = makeHarness({ testLogins: [] });
    return Effect.gen(function* () {
      const found = yield* harness.call("request_credentials", { domain: "github.com" });
      expect(found.structuredContent).toEqual({ items: [] });
      const filled = yield* harness.call("fill_credential", { itemId: ITEM_ID, field: "password" });
      expect(filled.structuredContent).toMatchObject({ status: "item_not_found" });
      expect(harness.brokerCalls).toEqual([]);
    }).pipe(Effect.scoped, Effect.provide(harness.layer));
  });
});
