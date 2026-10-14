// @effect-diagnostics nodeBuiltinImport:off - Adapts native debugger callbacks to a local Playwright connection.
import {
  PreviewAutomationClickInput,
  PreviewAutomationNavigateInput,
  PreviewAutomationTypeInput,
  type DesktopTabBinding,
  type PreviewAutomationRequest,
  type PreviewAutomationResponse,
} from "@t3tools/contracts";
import * as PageOperations from "@t3tools/shared/previewPage";
import { BrowserControlInterrupted, SessionControl } from "@t3tools/shared/previewSessionControl";
import { redactSensitiveValues } from "@t3tools/shared/credentialFill";
import { normalizePreviewUrl } from "@t3tools/shared/preview";
import * as NodeSocketServer from "@effect/platform-node/NodeSocketServer";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Queue from "effect/Queue";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import * as Schema from "effect/Schema";
import * as NodeCrypto from "node:crypto";
import { chromium, type Browser, type Page } from "playwright-core";
import { createCdpRelayConnection, type CdpRelayTarget } from "./CdpRelay.ts";

const decodeNavigate = Schema.decodeUnknownSync(PreviewAutomationNavigateInput);
const decodeClick = Schema.decodeUnknownSync(PreviewAutomationClickInput);
const decodeType = Schema.decodeUnknownSync(PreviewAutomationTypeInput);

/** Owns one local CDP endpoint. Closing it disconnects Playwright, never the user's page. */
export class DesktopTabRunner {
  private readonly scope = Scope.makeUnsafe();
  private browser: Browser | null = null;
  private page: Page | null = null;
  private acting = false;
  readonly control = new SessionControl(null, () => {
    if (this.page) PageOperations.invalidateRefs(this.page);
  });

  readonly binding: DesktopTabBinding;
  readonly connectionId: string;
  private readonly redact: <A>(value: A) => A;
  private readonly changed: (active: boolean) => void;
  private readonly pointer: PageOperations.PointerReporter;
  constructor(
    binding: DesktopTabBinding,
    connectionId: string,
    changed: (active: boolean) => void,
    redact: <A>(value: A) => A = (value) => value,
    pointer: PageOperations.PointerReporter = async () => {},
  ) {
    this.binding = binding;
    this.connectionId = connectionId;
    this.changed = changed;
    this.redact = redact;
    this.pointer = pointer;
  }

  async attach(
    target: CdpRelayTarget,
    events: {
      on: (listener: (method: string, params: unknown, sessionId: string) => void) => () => void;
    },
  ) {
    const endpoint = await Effect.runPromise(
      Effect.gen(function* () {
        const path = `/${NodeCrypto.randomBytes(24).toString("base64url")}`;
        const server = yield* NodeSocketServer.makeWebSocket({
          host: "127.0.0.1",
          port: 0,
          path,
        });
        const output = yield* Queue.unbounded<string>();
        const relay = createCdpRelayConnection(target, (message) => {
          Effect.runFork(Queue.offer(output, message));
        });
        const unsubscribe = events.on((method, params, sessionId) =>
          relay.event(method, params, sessionId),
        );
        yield* Effect.addFinalizer(() => Effect.sync(unsubscribe));
        let connected = false;
        yield* server
          .run((socket) =>
            Effect.gen(function* () {
              if (connected) return;
              connected = true;
              const writer = yield* socket.writer;
              const reader = yield* socket.reader;
              yield* Stream.fromQueue(output).pipe(
                Stream.runForEach((message) => writer.write(message)),
                Effect.forkScoped,
              );
              const decoder = new TextDecoder();
              return yield* reader.pull.pipe(
                Effect.flatMap((frames) =>
                  Effect.sync(() => {
                    for (const frame of frames)
                      relay.receive(typeof frame === "string" ? frame : decoder.decode(frame));
                  }),
                ),
                Effect.forever,
              );
            }).pipe(Effect.scoped, Effect.ignore),
          )
          .pipe(Effect.forkScoped);
        const address = server.address;
        if (address._tag !== "InetAddressV4")
          return yield* Effect.die("Unexpected desktop tab endpoint address.");
        return `ws://127.0.0.1:${address.port}${path}`;
      }).pipe(Scope.provide(this.scope)),
    );
    // The manager retains the debugger between connections. Re-enabling Runtime
    // must announce existing contexts to this fresh Playwright connection.
    await target.send("Runtime.disable", {}, undefined);
    this.browser = await chromium.connectOverCDP(endpoint);
    const pages = this.browser.contexts().flatMap((context) => context.pages());
    if (pages.length !== 1) throw new Error("Desktop tab relay requires exactly one page.");
    this.page = pages[0]!;
    this.report();
  }

  private report() {
    this.changed(this.acting);
  }

  async close() {
    const draining = this.control.close();
    this.acting = false;
    this.report();
    await Effect.runPromise(Scope.close(this.scope, Exit.void));
    await this.browser?.close();
    await draining;
  }

  async respond(request: PreviewAutomationRequest): Promise<PreviewAutomationResponse> {
    const identity = {
      clientId: "desktop",
      connectionId: this.connectionId,
      requestId: request.requestId,
    };
    try {
      return { ...identity, ok: true, result: this.redact(await this.execute(request)) };
    } catch (cause) {
      const error = PageOperations.toOperationError(cause);
      return {
        ...identity,
        ok: false,
        error: { _tag: error.tag, message: "Desktop tab operation failed.", detail: error.detail },
      };
    }
  }

  async execute(request: PreviewAutomationRequest): Promise<unknown> {
    const page = this.page;
    if (!page || request.tabId !== this.binding.tabId || request.threadId !== this.binding.threadId)
      throw new BrowserControlInterrupted(
        "This desktop tab belongs to another thread.",
        "agentMismatch",
      );
    if (request.operation === "status")
      return {
        available: true,
        visible: true,
        tabId: this.binding.tabId,
        url: page.url(),
        title: await page.title(),
        loading: false,
        control: {
          owner: this.acting ? "agent" : "unclaimed",
          ownedByCaller: true,
          generation: this.control.generation,
        },
        tabs: [
          {
            tabId: this.binding.tabId,
            url: page.url(),
            host: this.binding.deviceName,
            runtime: "desktop",
            owner: this.acting ? "agent" : "unclaimed",
          },
        ],
      };
    if (request.operation === "credentialLock")
      return { locked: await PageOperations.credentialLocked(page), available: true };
    if (request.operation === "snapshot")
      return this.control.observe(async () => {
        const generation = this.control.generation;
        const cdp = await page.context().newCDPSession(page);
        try {
          // Check both sides of capture: a credential fill or disconnect may land while reading.
          await PageOperations.credentialLocked(page);
          const snapshot = await PageOperations.snapshot({
            page,
            cdp,
            renderScale: 1,
            consoleEntries: [],
            networkEntries: [],
            actionTimeline: [],
            includeScreenshot: false,
          });
          await PageOperations.credentialLocked(page);
          const secrets = await PageOperations.sensitiveInputValues(page);
          if (generation !== this.control.generation) throw new BrowserControlInterrupted();
          return redactSensitiveValues(snapshot, secrets);
        } finally {
          await cdp.detach();
        }
      });
    if (!["navigate", "click", "type"].includes(request.operation))
      throw new PageOperations.ServerBrowserOperationError(
        "PreviewAutomationExecutionError",
        "Not supported on desktop tabs yet.",
      );
    return this.control.agent(request.agentSessionId ?? "agent", async () => {
      this.acting = true;
      this.report();
      try {
        switch (request.operation) {
          case "navigate": {
            const input = decodeNavigate(request.input);
            const url = input.url ?? (input.target?.kind === "url" ? input.target.url : undefined);
            if (!url)
              throw new PageOperations.ServerBrowserOperationError(
                "PreviewAutomationExecutionError",
                "Not supported on desktop tabs yet. Navigate with a URL.",
              );
            await page.goto(normalizePreviewUrl(url), {
              waitUntil: "domcontentloaded",
              timeout: request.timeoutMs,
            });
            return {
              available: true,
              visible: true,
              tabId: this.binding.tabId,
              url: page.url(),
              title: await page.title(),
              loading: false,
            };
          }
          case "click":
            await PageOperations.click(page, decodeClick(request.input), this.pointer);
            break;
          case "type":
            await PageOperations.type(page, decodeType(request.input));
            break;
        }
        return {};
      } finally {
        this.acting = false;
        this.report();
      }
    });
  }
}
