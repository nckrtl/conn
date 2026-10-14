import {
  EnvironmentId,
  ThreadId,
  type PreviewAutomationRequest,
  type PreviewAutomationStreamEvent,
} from "@t3tools/contracts";
import { AsyncResult } from "effect/reactivity";
import { expect, it, vi } from "vite-plus/test";

const mocks = vi.hoisted(() => ({
  phase: "connected",
  listener: () => {},
  runCommand:
    vi.fn<(registry: unknown, command: string, args: { input: unknown }) => Promise<unknown>>(),
  connect: vi.fn<(input: unknown) => Promise<void>>(),
  disconnect: vi.fn<() => Promise<void>>(),
  execute:
    vi.fn<
      (tab: string, connectionId: string, request: PreviewAutomationRequest) => Promise<unknown>
    >(),
}));
vi.mock("@t3tools/client-runtime/state/runtime", () => ({ runAtomCommand: mocks.runCommand }));
vi.mock("./atomRegistry", () => ({
  appAtomRegistry: {
    get: () => AsyncResult.success({ phase: mocks.phase }),
    subscribe: (_atom: unknown, listener: () => void) => {
      mocks.listener = listener;
      return () => {};
    },
  },
}));
vi.mock("~/connection/catalog", () => ({ environmentCatalog: { stateAtom: () => "connection" } }));
vi.mock("~/state/preview", () => ({
  previewEnvironment: {
    desktopRegister: "register",
    desktopRequests: "requests",
    desktopRespond: "respond",
  },
}));
vi.mock("~/previewStateStore", () => ({
  readThreadPreviewState: () => ({
    sessions: {
      tab: { tabId: "tab", threadId: "thread", runtime: "desktop", navStatus: { _tag: "Idle" } },
    },
  }),
}));
vi.mock("~/components/preview/previewBridge", () => ({
  previewBridge: {
    connectTabHost: mocks.connect,
    disconnectTabHost: mocks.disconnect,
    executeTabRequest: mocks.execute,
  },
}));
import { hostDesktopTab } from "./desktopTabRelay";

const deferred = <T>() => {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
};

it("reads status during an action and re-registers the same tab without forwarding a retired reply", async () => {
  const streams = new Map<
    string,
    { onEvent: (event: PreviewAutomationStreamEvent) => Promise<void>; signal: AbortSignal }
  >();
  const responses: unknown[] = [];
  let registration = 0;
  let attached = deferred<void>();
  let responded = deferred<void>();
  const navigation = deferred<unknown>();
  mocks.connect.mockImplementation(async () => {
    attached.resolve();
  });
  mocks.disconnect.mockResolvedValue(undefined);
  mocks.runCommand.mockImplementation(async (_registry, command, { input }) => {
    if (command === "register")
      return AsyncResult.success({ connectionId: `connection-${++registration}` });
    if (command === "respond") {
      responses.push(input);
      responded.resolve();
      return AsyncResult.success(undefined);
    }
    const stream = input as {
      connectionId: string;
      onEvent: (event: PreviewAutomationStreamEvent) => Promise<void>;
      signal: AbortSignal;
    };
    streams.set(stream.connectionId, stream);
    return new Promise<void>((resolve) =>
      stream.signal.addEventListener("abort", () => resolve(), { once: true }),
    );
  });
  mocks.execute.mockImplementation(async (_tab, connectionId, request) => {
    if (request.operation === "navigate") await navigation.promise;
    return {
      clientId: "desktop",
      connectionId,
      requestId: request.requestId,
      ok: true,
      result: {},
    };
  });
  const stop = hostDesktopTab(
    { environmentId: EnvironmentId.make("environment"), threadId: ThreadId.make("thread") },
    "tab",
    "same-guest",
  );
  const event = (
    connectionId: string,
    operation: PreviewAutomationRequest["operation"],
  ): PreviewAutomationStreamEvent => ({
    type: "request",
    connectionId,
    request: {
      requestId: operation,
      tabId: "tab",
      threadId: ThreadId.make("thread"),
      operation,
      input: {},
      timeoutMs: 1000,
    },
  });
  try {
    await attached.promise;
    await Promise.resolve();
    await streams.get("connection-1")!.onEvent(event("connection-1", "navigate"));
    await streams.get("connection-1")!.onEvent(event("connection-1", "status"));
    await responded.promise;
    expect(responses).toMatchObject([{ connectionId: "connection-1", requestId: "status" }]);
    mocks.phase = "disconnected";
    mocks.listener();
    attached = deferred<void>();
    mocks.phase = "connected";
    mocks.listener();
    await attached.promise;
    await Promise.resolve();
    expect(streams.get("connection-1")!.signal.aborted).toBe(true);
    expect(mocks.connect.mock.calls[1]?.[0]).toMatchObject({
      runtimeTabId: "same-guest",
      connectionId: "connection-2",
    });
    navigation.resolve(undefined);
    responded = deferred<void>();
    await streams.get("connection-2")!.onEvent(event("connection-2", "snapshot"));
    await responded.promise;
    expect(responses).toMatchObject([
      { connectionId: "connection-1", requestId: "status" },
      { connectionId: "connection-2", requestId: "snapshot" },
    ]);
    expect(responses).toHaveLength(2);
  } finally {
    stop();
  }
});
