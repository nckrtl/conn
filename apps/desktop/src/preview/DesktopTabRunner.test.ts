import { fillCredential } from "@t3tools/shared/previewPage";
import { chromium, type Browser, type BrowserContext, type Page } from "playwright-core";
import { beforeAll, afterAll, beforeEach, afterEach, describe, it, expect } from "vite-plus/test";
import {
  EnvironmentId,
  ThreadId,
  PreviewTabId,
  type PreviewAutomationRequest,
  type DesktopTabReport,
} from "@t3tools/contracts";
import { credentialFieldExpression, redactSensitiveValues } from "@t3tools/shared/credentialFill";
import { DesktopTabRunner } from "./DesktopTabRunner.ts";

const binding = {
  environmentId: EnvironmentId.make("fixture-environment"),
  serverEpoch: "fixture-epoch",
  threadId: ThreadId.make("fixture-thread"),
  tabId: PreviewTabId.make("fixture-tab"),
  deviceName: "Fixture desktop",
};
const request = (
  operation: PreviewAutomationRequest["operation"],
  input: unknown = {},
): PreviewAutomationRequest => ({
  requestId: "request-1",
  threadId: binding.threadId,
  tabId: binding.tabId,
  controlGeneration: 0,
  operation,
  input,
  timeoutMs: 1_000,
});

describe("desktop tab runner", () => {
  let browser: Browser;
  let context: BrowserContext;
  let page: Page;
  let runner: DesktopTabRunner;
  let reports: DesktopTabReport[];
  let remembered: string[];
  let nativeButton: "left" | "right" | undefined;
  beforeAll(async () => {
    browser = await chromium.launch({ headless: true });
  });
  afterAll(async () => {
    await browser?.close();
  });
  beforeEach(async () => {
    context = await browser.newContext();
    page = await context.newPage();
    await page.setContent(
      '<input id="password" type="password"><input id="name"><button onclick="this.textContent=\'Done\'">Send</button>',
    );
    reports = [];
    remembered = [];
    nativeButton = undefined;
    runner = new DesktopTabRunner(
      binding,
      "connection-1",
      (report) => reports.push(report),
      (value) => redactSensitiveValues(value, remembered),
    );
    const cdp = await context.newCDPSession(page);
    // Electron's manager retains an already-enabled debugger across shares.
    await cdp.send("Runtime.enable");
    await runner.attach(
      {
        send: (method, params) => {
          if (method === "Input.dispatchMouseEvent") {
            const type = {
              mouseMoved: "mouseMove",
              mousePressed: "mouseDown",
              mouseReleased: "mouseUp",
            }[String(params.type)];
            if (type)
              runner.nativeInput({
                type,
                x: Number(params.x),
                y: Number(params.y),
                ...(params.button === "left" ||
                params.button === "middle" ||
                params.button === "right"
                  ? { button: nativeButton ?? params.button }
                  : {}),
              } as Electron.MouseInputEvent);
          }
          return cdp.send(method as Parameters<typeof cdp.send>[0], params as never);
        },
        targetId: async () => (await cdp.send("Target.getTargetInfo")).targetInfo.targetId,
        url: () => page.url(),
        title: () => "Fixture",
        userAgent: () => "Fixture",
        setDownloadDirectory: () => {},
      },
      {
        on: (listener) => {
          const forward = (event: { method: string; params: unknown }) =>
            listener(event.method, event.params, "");
          // The native debugger emits the same page events the CDP client receives.
          const methods = [
            "Page.frameNavigated",
            "Page.lifecycleEvent",
            "Page.frameStartedLoading",
            "Page.frameStoppedLoading",
            "Runtime.executionContextCreated",
            "Runtime.executionContextDestroyed",
            "Runtime.executionContextsCleared",
          ];
          const removers = methods.map((method) => {
            const handler = (params: unknown) => forward({ method, params });
            cdp.on(method as Parameters<typeof cdp.on>[0], handler);
            return () => cdp.off(method as Parameters<typeof cdp.off>[0], handler);
          });
          return () => {
            for (const remove of removers) remove();
          };
        },
      },
    );
  });
  afterEach(async () => {
    await runner?.close();
    await context?.close();
  });

  it("uses the shared snapshot refs for clicks and typing without a screenshot", async () => {
    const result = await runner.respond(request("snapshot"));
    expect(result.ok).toBe(true);
    const snapshot = result.result as { accessibilityTree: string; screenshot: { data: string } };
    expect(snapshot.screenshot.data).toBe("");
    const ref = snapshot.accessibilityTree.match(/button "Send" \[ref=([^\]]+)\]/)?.[1];
    expect(ref).toBeTruthy();
    expect((await runner.respond(request("click", { locator: `aria-ref=${ref}` }))).ok).toBe(true);
    expect(await page.locator("button").textContent()).toBe("Done");
    expect((await runner.respond(request("type", { locator: "#name", text: "Fixture" }))).ok).toBe(
      true,
    );
    expect(await page.locator("#name").inputValue()).toBe("Fixture");
    expect((await runner.respond(request("evaluate", { expression: "1+1" }))).ok).toBe(false);
  });

  it("redacts filled credentials from text and aria snapshots and fails closed on a lock check error", async () => {
    const secret = "fixture-secret-value";
    const cdp = await context.newCDPSession(page);
    expect(
      await fillCredential(
        page,
        cdp,
        {
          initiator: "user",
          field: "password",
          expectedOrigin: "null",
          fieldExpression: credentialFieldExpression("password"),
          value: secret,
        },
        (value) => remembered.push(value),
      ),
    ).toEqual({ status: "filled" });
    await cdp.detach();
    await page.evaluate(() => {
      document.body.append("fixture-secret-value");
      document.querySelector("#password")?.remove();
    });
    const response = await runner.respond(request("snapshot"));
    expect(response.ok).toBe(true);
    expect(JSON.stringify(response)).not.toContain(secret);
    await page
      .evaluate(() => {
        Object.defineProperty(window, "__t3codeCredentialLocked", {
          get() {
            throw new Error("Cannot check");
          },
        });
      })
      .catch(() => undefined);
    // A page that will not execute the lock expression must not produce a snapshot.
    await page.addInitScript(() => {
      Object.defineProperty(window, "__t3codeCredentialLocked", {
        get() {
          throw new Error("Cannot check");
        },
      });
    });
    await page.goto("about:blank");
    expect((await runner.respond(request("snapshot"))).ok).toBe(false);
  });

  it("a different native mouse button takes control even during an agent click", async () => {
    nativeButton = "right";
    const response = await runner.respond(request("click", { locator: "button" }));
    expect(response.ok).toBe(false);
    expect(reports.at(-1)?.shared).toBe(false);
    expect((await runner.respond(request("snapshot"))).ok).toBe(false);
  });

  it("navigates the attached tab and snapshots its new document", async () => {
    await page.route("https://fixture.test/**", (route) =>
      route.fulfill({
        contentType: "text/html",
        body: "<title>Destination</title><p>Arrived</p>",
      }),
    );
    const navigation = await runner.respond(
      request("navigate", { url: "https://fixture.test/destination" }),
    );
    expect(navigation.ok).toBe(true);
    expect(navigation.result).toMatchObject({
      url: "https://fixture.test/destination",
      title: "Destination",
    });
    const snapshot = await runner.respond(request("snapshot"));
    expect(snapshot.ok).toBe(true);
    expect(snapshot.result).toMatchObject({ visibleText: "Arrived" });
  });

  it("takeover rejects an already queued action and leaves the user's page open", async () => {
    let release!: () => void;
    let started!: () => void;
    const running = new Promise<void>((resolve) => {
      started = resolve;
    });
    const blocker = runner.control.agent("agent", () => {
      started();
      return new Promise<void>((resolve) => {
        release = resolve;
      });
    });
    await running;
    const queued = runner.respond(request("type", { locator: "#name", text: "must not land" }));
    runner.nativeInput({ type: "mouseDown", x: 9, y: 9, button: "left" });
    release();
    await blocker;
    expect((await queued).ok).toBe(false);
    expect(await page.locator("#name").inputValue()).toBe("");
    expect((await runner.respond(request("snapshot"))).ok).toBe(false);
    await runner.close();
    expect(page.isClosed()).toBe(false);
    expect(reports.at(-1)?.shared).toBe(false);
  });
});
