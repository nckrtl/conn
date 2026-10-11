import { describe, expect, it } from "@effect/vitest";
import {
  type CredentialAutofillSettings,
  EnvironmentId,
  PreviewTabId,
  PreviewAutomationExecutionError,
  ProviderInstanceId,
  ThreadId,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import { McpSchema, McpServer } from "effect/unstable/ai";

import * as CredentialAutofill from "../credentials/CredentialAutofill.ts";
import * as CredentialProvider from "../credentials/CredentialProvider.ts";
import * as ProcessRunner from "../processRunner.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as TestLoginStore from "../credentials/TestLoginStore.ts";
import * as McpHttpServer from "./McpHttpServer.ts";
import * as McpInvocationContext from "./McpInvocationContext.ts";
import * as PreviewAutomationBroker from "./PreviewAutomationBroker.ts";

const SECRET = "s3cret-Value!42";
const ITEM_ID = "abcdefghijklmnopqrstuvwxyz";
const VAULT_ID = "vaultvaultvaultvaultvault1";

const invocation = (capabilities: ReadonlyArray<McpInvocationContext.McpCapability>) => ({
  environmentId: EnvironmentId.make("environment-credentials-test"),
  threadId: ThreadId.make("thread-credentials-test"),
  providerSessionId: "provider-session-credentials-test",
  providerInstanceId: ProviderInstanceId.make("codex"),
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

const itemList = toJson([
  {
    id: ITEM_ID,
    title: "GitHub",
    category: "LOGIN",
    vault: { id: VAULT_ID, name: "Private" },
    additional_information: "nick@example.com",
    urls: [{ label: "website", primary: true, href: "https://github.com/login" }],
  },
  {
    id: "zyxwvutsrqponmlkjihgfedcba",
    title: "GitLab",
    vault: { id: VAULT_ID, name: "Private" },
    urls: [{ href: "https://gitlab.com" }],
  },
]);

interface Scenario {
  readonly tabUrl?: string | null;
  /** The document id the desktop reports. Omitted: a host that predates ids. */
  readonly documentId?: number;
  readonly approved?: boolean;
  /** Fields a sign-in prompt answers with. */
  readonly approvedFields?: ReadonlyArray<string>;
  readonly fillFails?: boolean;
  readonly settings?: Partial<CredentialAutofillSettings>;
  readonly testLogins?: ReadonlyArray<TestLoginStore.StoredTestLogin>;
  /** 1Password's CLI fails, as when it is locked or missing. */
  readonly onePasswordDown?: boolean;
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
  const opCalls: Array<ReadonlyArray<string>> = [];
  const brokerCalls: Array<{
    operation: string;
    input: unknown;
    tabId?: string;
    clientId?: string;
  }> = [];
  const output = (stdout: string): ProcessRunner.ProcessRunOutput => ({
    stdout,
    stderr: "",
    code: 0 as ProcessRunner.ProcessRunOutput["code"],
    timedOut: false,
    stdoutTruncated: false,
    stderrTruncated: false,
    stdoutInvalidUtf8: false,
    stderrInvalidUtf8: false,
  });
  const runner = Layer.mock(ProcessRunner.ProcessRunner)({
    run: (input) => {
      opCalls.push(input.args);
      if (scenario.onePasswordDown) return Effect.succeed({ ...output(""), code: 1 as never });
      return Effect.succeed(output(input.args[0] === "read" ? SECRET : itemList));
    },
  });
  const savedTestLogins: Array<TestLoginStore.StoredTestLogin> = [...(scenario.testLogins ?? [])];
  const testLoginStore = Layer.mock(TestLoginStore.TestLoginStore)({
    list: Effect.sync(() => [...savedTestLogins]),
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
  /** What the tab shows now; a test changes it to navigate. */
  const page = {
    url: scenario.tabUrl === undefined ? "https://github.com/login" : scenario.tabUrl,
    documentId: scenario.documentId,
  };
  const documentFields = () =>
    page.documentId === undefined ? {} : { documentId: page.documentId };
  const broker = Layer.mock(PreviewAutomationBroker.PreviewAutomationBroker)({
    invoke: <A>(request: PreviewAutomationBroker.PreviewAutomationInvokeInput) => {
      brokerCalls.push({
        operation: request.operation,
        input: request.input,
        ...(request.tabId === undefined ? {} : { tabId: request.tabId }),
        ...(request.clientId === undefined ? {} : { clientId: request.clientId }),
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
            ...documentFields(),
          } as A);
        }
        case "credentialApproval":
          return Effect.succeed({
            approved: scenario.approved ?? true,
            ...(scenario.approvedFields ? { fields: scenario.approvedFields } : {}),
          } as A);
        case "credentialFill":
          return scenario.fillFails
            ? Effect.fail(
                new PreviewAutomationExecutionError({
                  operation: "credentialFill",
                  environmentId: request.scope.environmentId,
                  threadId: request.scope.threadId,
                  providerSessionId: request.scope.providerSessionId,
                  providerInstanceId: request.scope.providerInstanceId,
                  clientId: "client",
                  connectionId: "connection",
                  requestId: "preview-1",
                  timeoutMs: 15_000,
                  remoteTag: "PreviewAutomationExecutionError",
                  remoteMessageLength: 0,
                  cause: null,
                }),
              )
            : Effect.succeed({ status: "filled", ...documentFields() } as A);
        default:
          return Effect.die(`unexpected operation ${request.operation}`);
      }
    },
  });
  const layer = McpHttpServer.CredentialsToolkitRegistrationLive.pipe(
    Layer.provideMerge(McpServer.McpServer.layer),
    Layer.provideMerge(CredentialAutofill.layer),
    Layer.provide(CredentialProvider.layerOnePassword),
    Layer.provide(runner),
    Layer.provide(broker),
    Layer.provide(ServerSettings.layerTest({ credentialAutofill: scenario.settings ?? {} })),
    Layer.provide(testLoginStore),
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
  return { opCalls, brokerCalls, layer, call, scope, savedTestLogins, page };
};

const secretReads = (opCalls: ReadonlyArray<ReadonlyArray<string>>) =>
  opCalls.filter((args) => args[0] === "read" || args.includes("--otp"));

describe("credentials MCP tools", () => {
  it.effect("lists matching logins as metadata without revealing fields", () => {
    const harness = makeHarness();
    return Effect.gen(function* () {
      const server = yield* McpServer.McpServer;
      expect(server.tools.map(({ tool }) => tool.name).toSorted()).toEqual([
        "fill_credential",
        "request_credentials",
        "save_test_login",
      ]);
      const result = yield* harness.call("request_credentials", { domain: "github.com" });
      expect(result.isError).toBe(false);
      expect(result.structuredContent).toEqual({
        items: [
          { id: ITEM_ID, title: "GitHub", urls: ["https://github.com/login"], source: "1password" },
        ],
      });
      // The username hint 1Password lists is not passed on.
      expect(toJson(result)).not.toContain("nick@example.com");
      expect(harness.opCalls).toEqual([
        ["item", "list", "--categories", "Login", "--format", "json"],
      ]);
      expect(harness.opCalls.flat()).not.toContain("--reveal");
    }).pipe(Effect.scoped, Effect.provide(harness.layer));
  });

  it.effect("fills after approval and returns only a status", () => {
    const harness = makeHarness();
    return Effect.gen(function* () {
      const result = yield* harness.call("fill_credential", {
        itemId: ITEM_ID,
        field: "password",
      });
      expect(result.isError).toBe(false);
      expect(result.structuredContent).toMatchObject({ status: "filled" });
      expect(toJson(result)).not.toContain(SECRET);

      expect(harness.brokerCalls.map((entry) => entry.operation)).toEqual([
        "status",
        "credentialApproval",
        "credentialFill",
      ]);
      const [, approval, fill] = harness.brokerCalls;
      // The prompt names the item and origin, and holds no secret.
      expect(approval!.input).toMatchObject({
        itemTitle: "GitHub",
        providerLabel: "1Password",
        origin: "https://github.com",
        field: "password",
        timeoutSeconds: 90,
      });
      expect(toJson(approval!.input)).not.toContain(SECRET);
      expect(approval!.tabId).toBe("tab-1");
      // The secret only travels in the fill request, pinned to the checked tab and origin.
      expect(fill!.tabId).toBe("tab-1");
      expect(fill!.input).toMatchObject({
        field: "password",
        expectedOrigin: "https://github.com",
        value: SECRET,
      });
      expect(harness.opCalls).toContainEqual([
        "read",
        "--no-newline",
        `op://${VAULT_ID}/${ITEM_ID}/password`,
      ]);
    }).pipe(Effect.scoped, Effect.provide(harness.layer));
  });

  it.effect("reads no secret when the user denies", () => {
    const harness = makeHarness({ approved: false });
    return Effect.gen(function* () {
      const result = yield* harness.call("fill_credential", { itemId: ITEM_ID, field: "password" });
      expect(result.structuredContent).toMatchObject({ status: "denied" });
      expect(secretReads(harness.opCalls)).toEqual([]);
      expect(harness.brokerCalls.map((entry) => entry.operation)).not.toContain("credentialFill");
    }).pipe(Effect.scoped, Effect.provide(harness.layer));
  });

  it.effect("refuses another origin without asking the user or reading a secret", () => {
    const harness = makeHarness({ tabUrl: "https://github.com.evil.example/login" });
    return Effect.gen(function* () {
      const result = yield* harness.call("fill_credential", { itemId: ITEM_ID, field: "password" });
      expect(result.structuredContent).toMatchObject({ status: "origin_mismatch" });
      expect(harness.brokerCalls.map((entry) => entry.operation)).toEqual(["status"]);
      expect(secretReads(harness.opCalls)).toEqual([]);
    }).pipe(Effect.scoped, Effect.provide(harness.layer));
  });

  it.effect("reports a tab without a page", () => {
    const harness = makeHarness({ tabUrl: null });
    return Effect.gen(function* () {
      const result = yield* harness.call("fill_credential", { itemId: ITEM_ID, field: "username" });
      expect(result.structuredContent).toMatchObject({ status: "tab_unavailable" });
      expect(secretReads(harness.opCalls)).toEqual([]);
    }).pipe(Effect.scoped, Effect.provide(harness.layer));
  });

  it.effect("reads one-time codes through --otp", () => {
    const harness = makeHarness();
    return Effect.gen(function* () {
      const result = yield* harness.call("fill_credential", { itemId: ITEM_ID, field: "otp" });
      expect(result.structuredContent).toMatchObject({ status: "filled" });
      expect(harness.opCalls).toContainEqual([
        "item",
        "get",
        ITEM_ID,
        "--vault",
        VAULT_ID,
        "--otp",
      ]);
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
        itemId: "zzzzzzzzzzzzzzzzzzzzzzzzzz",
        field: "password",
      });
      expect(unknown.structuredContent).toMatchObject({ status: "item_not_found" });
      const denied = yield* harness.call(
        "fill_credential",
        { itemId: ITEM_ID, field: "password" },
        [] as never,
      );
      expect(denied.isError).toBe(true);
      expect(secretReads(harness.opCalls)).toEqual([]);
    }).pipe(Effect.scoped, Effect.provide(harness.layer));
  });

  it.effect("one sign-in approval covers the login's other fields", () => {
    const harness = makeHarness({
      settings: { oneApprovalPerSignIn: true },
      approvedFields: ["username", "password"],
    });
    return Effect.gen(function* () {
      const first = yield* harness.call("fill_credential", { itemId: ITEM_ID, field: "username" });
      expect(first.structuredContent).toMatchObject({ status: "filled" });
      const approvals = () =>
        harness.brokerCalls.filter((entry) => entry.operation === "credentialApproval");
      expect(approvals()[0]!.input).toMatchObject({
        field: "username",
        signInFields: ["username", "password", "otp"],
        timeoutSeconds: 90,
      });
      const second = yield* harness.call("fill_credential", { itemId: ITEM_ID, field: "password" });
      expect(second.structuredContent).toMatchObject({ status: "filled" });
      expect(approvals()).toHaveLength(1);
      // The user left the code unticked, so it asks again.
      yield* harness.call("fill_credential", { itemId: ITEM_ID, field: "otp" });
      expect(approvals()).toHaveLength(2);
    }).pipe(Effect.scoped, Effect.provide(harness.layer));
  });

  it.effect("asks on every fill when sign-in approvals are off", () => {
    const harness = makeHarness();
    return Effect.gen(function* () {
      yield* harness.call("fill_credential", { itemId: ITEM_ID, field: "username" });
      yield* harness.call("fill_credential", { itemId: ITEM_ID, field: "username" });
      const approvals = harness.brokerCalls.filter(
        (entry) => entry.operation === "credentialApproval",
      );
      expect(approvals).toHaveLength(2);
      expect(approvals[0]!.input).not.toHaveProperty("signInFields");
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

  it.effect("blocks agent scripts in the tab until its page changes", () => {
    const harness = makeHarness();
    return Effect.gen(function* () {
      const autofill = yield* CredentialAutofill.CredentialAutofill;
      // Nothing filled yet: scripts run without even asking the tab.
      yield* autofill.guardScript(harness.scope, undefined);
      expect(harness.brokerCalls).toEqual([]);
      yield* harness.call("fill_credential", { itemId: ITEM_ID, field: "password" });
      const blocked = yield* autofill.guardScript(harness.scope, undefined).pipe(Effect.result);
      expect(blocked._tag).toBe("Failure");
      if (blocked._tag === "Failure") {
        expect(blocked.failure._tag).toBe("PreviewAutomationCredentialLockError");
      }
    }).pipe(Effect.scoped, Effect.provide(harness.layer));
  });

  it.effect("keeps the script lock across hash and pushState changes of the same document", () => {
    const harness = makeHarness({ documentId: 7 });
    return Effect.gen(function* () {
      const autofill = yield* CredentialAutofill.CredentialAutofill;
      const locked = () => autofill.isScriptLocked(harness.scope, undefined);
      yield* harness.call("fill_credential", { itemId: ITEM_ID, field: "password" });
      // history.pushState and a hash link change the URL, not the document.
      harness.page.url = "https://github.com/login#step-2";
      expect(yield* locked()).toBe(true);
      harness.page.url = "https://github.com/session?x=1";
      expect(yield* locked()).toBe(true);
      const blocked = yield* autofill.guardScript(harness.scope, undefined).pipe(Effect.result);
      expect(blocked._tag).toBe("Failure");
      // A new document releases it, even at the same URL (a reload).
      harness.page.documentId = 8;
      harness.page.url = "https://github.com/login";
      expect(yield* locked()).toBe(false);
      yield* autofill.guardScript(harness.scope, undefined);
      // And it stays released if the old document id comes back.
      harness.page.documentId = 7;
      expect(yield* locked()).toBe(false);
    }).pipe(Effect.scoped, Effect.provide(harness.layer));
  });

  it.effect("without document ids, keeps the lock across a hash change only", () => {
    const harness = makeHarness();
    return Effect.gen(function* () {
      const autofill = yield* CredentialAutofill.CredentialAutofill;
      yield* harness.call("fill_credential", { itemId: ITEM_ID, field: "password" });
      harness.page.url = "https://github.com/login#step-2";
      expect(yield* autofill.isScriptLocked(harness.scope, undefined)).toBe(true);
      harness.page.url = "https://github.com/session";
      expect(yield* autofill.isScriptLocked(harness.scope, undefined)).toBe(false);
    }).pipe(Effect.scoped, Effect.provide(harness.layer));
  });

  it.effect("does not block scripts after a username fill or with the setting off", () => {
    const username = makeHarness();
    const off = makeHarness({ settings: { blockScriptsAfterFill: false } });
    return Effect.gen(function* () {
      yield* Effect.gen(function* () {
        const autofill = yield* CredentialAutofill.CredentialAutofill;
        yield* username.call("fill_credential", { itemId: ITEM_ID, field: "username" });
        yield* autofill.guardScript(username.scope, undefined);
      }).pipe(Effect.provide(username.layer));
      yield* Effect.gen(function* () {
        const autofill = yield* CredentialAutofill.CredentialAutofill;
        yield* off.call("fill_credential", { itemId: ITEM_ID, field: "password" });
        yield* autofill.guardScript(off.scope, undefined);
      }).pipe(Effect.provide(off.layer));
    }).pipe(Effect.scoped);
  });

  it.effect("lists the site's logins with username hints for the user's key menu", () => {
    const harness = makeHarness();
    return Effect.gen(function* () {
      const autofill = yield* CredentialAutofill.CredentialAutofill;
      const site = yield* autofill.listForSite({ url: "https://github.com/login?return_to=/" });
      expect(site).toEqual({
        origin: "https://github.com",
        items: [
          { id: ITEM_ID, title: "GitHub", username: "nick@example.com", source: "1password" },
        ],
        unavailable: null,
      });
      const other = yield* autofill.listForSite({ url: "https://example.org/" });
      expect(other).toEqual({ origin: null, items: [], unavailable: null });
    }).pipe(Effect.scoped, Effect.provide(harness.layer));
  });

  it.effect("fills a login the user picked without a prompt, only through their host", () => {
    const harness = makeHarness();
    return Effect.gen(function* () {
      const autofill = yield* CredentialAutofill.CredentialAutofill;
      const filled = yield* autofill.fillForSite({
        environmentId: harness.scope.environmentId,
        threadId: harness.scope.threadId,
        tabId: PreviewTabId.make("tab-1"),
        hostClientId: "desktop-host-1",
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
      expect(harness.brokerCalls.every((entry) => entry.clientId === "desktop-host-1")).toBe(true);
      // The password fill locks agent scripts in that tab, as an agent fill would.
      const blocked = yield* autofill
        .guardScript(harness.scope, PreviewTabId.make("tab-1"))
        .pipe(Effect.result);
      expect(blocked._tag).toBe("Failure");
    }).pipe(Effect.scoped, Effect.provide(harness.layer));
  });

  it.effect("refuses a user fill on another site without reading a secret", () => {
    const harness = makeHarness({ tabUrl: "https://gitlab.com/users/sign_in" });
    return Effect.gen(function* () {
      const autofill = yield* CredentialAutofill.CredentialAutofill;
      const filled = yield* autofill.fillForSite({
        environmentId: harness.scope.environmentId,
        threadId: harness.scope.threadId,
        tabId: PreviewTabId.make("tab-1"),
        hostClientId: "desktop-host-1",
        itemId: ITEM_ID,
        fields: ["password"],
      });
      expect(filled.results).toEqual([{ field: "password", status: "origin_mismatch" }]);
      expect(secretReads(harness.opCalls)).toEqual([]);
    }).pipe(Effect.scoped, Effect.provide(harness.layer));
  });

  it.effect("fills a test login without a prompt or script lock", () => {
    const harness = makeHarness({ testLogins: [testLogin()] });
    return Effect.gen(function* () {
      const found = yield* harness.call("request_credentials", { domain: "github.com" });
      expect(found.structuredContent).toMatchObject({
        items: [
          { id: TEST_LOGIN_ID, source: "test", username: "admin@myapp.test" },
          { id: ITEM_ID, source: "1password" },
        ],
      });
      // 1Password usernames stay with the user.
      expect(toJson(found)).not.toContain("nick@example.com");

      const filled = yield* harness.call("fill_credential", {
        itemId: TEST_LOGIN_ID,
        field: "password",
      });
      expect(filled.structuredContent).toMatchObject({ status: "filled" });
      expect(harness.brokerCalls.map((entry) => entry.operation)).toEqual([
        "status",
        "credentialFill",
      ]);
      expect(harness.brokerCalls[1]!.input).toMatchObject({ value: "test-password" });
      expect(secretReads(harness.opCalls)).toEqual([]);
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
    const harness = makeHarness();
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

  it.effect("keeps test logins usable while 1Password is down", () => {
    const harness = makeHarness({ testLogins: [testLogin()], onePasswordDown: true });
    return Effect.gen(function* () {
      const autofill = yield* CredentialAutofill.CredentialAutofill;
      const site = yield* autofill.listForSite({ url: "https://github.com/login" });
      expect(site.items).toEqual([
        { id: TEST_LOGIN_ID, title: "admin", username: "admin@myapp.test", source: "test" },
      ]);
      expect(site.unavailable).not.toBeNull();
    }).pipe(Effect.scoped, Effect.provide(harness.layer));
  });
});
