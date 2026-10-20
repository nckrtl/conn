import { act, useEffect } from "react";
import { create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, expect, it, vi } from "vite-plus/test";
import { EnvironmentId, ThreadId, type PreviewAutomationStreamEvent } from "@t3tools/contracts";
import { AsyncResult } from "effect/reactivity";

const mocks = vi.hoisted(() => ({
  createTab: vi.fn(async () => {}),
  closeTab: vi.fn(async () => {}),
  registerWebview: vi.fn(async () => {}),
  connect: vi.fn(async () => {}),
  disconnect: vi.fn(async () => {}),
  runCommand: vi.fn(),
  config: { partition: "fixture", webPreferences: "backgroundThrottling=no", preloadUrl: null },
}));
vi.mock("~/env", () => ({ isElectron: true }));
vi.mock("~/hooks/useTheme", () => ({ useTheme: () => ({ resolvedTheme: "light" }) }));
vi.mock("~/hooks/useSettings", () => ({ useClientSettingsHydrated: () => true }));
vi.mock("~/state/session", () => ({ useEnvironmentScope: () => true }));
vi.mock("~/state/use-atom-command", () => ({ useAtomCommand: () => () => {} }));
vi.mock("~/state/primaryEnvironment", async () => {
  const { Atom } = await import("effect/reactivity");
  return { primaryEnvironmentIdAtom: Atom.make(null) };
});
vi.mock("~/connection/catalog", async () => {
  const { Atom, AsyncResult } = await import("effect/reactivity");
  const state = Atom.make(AsyncResult.success({ phase: "connected" }));
  return { environmentCatalog: { stateAtom: () => state } };
});
vi.mock("~/state/threads", async () => {
  const { Atom } = await import("effect/reactivity");
  const Option = await import("effect/Option");
  const state = Atom.make({ data: Option.some({ runs: [] }) });
  return { environmentThreadDetails: { stateAtom: () => state } };
});
vi.mock("@t3tools/client-runtime/state/runtime", () => ({ runAtomCommand: mocks.runCommand }));
vi.mock("~/state/preview", async () => {
  const { Atom } = await import("effect/reactivity");
  const list = Atom.make(null);
  return {
    previewEnvironment: {
      list: () => list,
      desktopRegister: "register",
      desktopRequests: "requests",
      desktopRespond: "respond",
    },
  };
});
vi.mock("~/components/preview/previewBridge", () => ({
  previewBridge: {
    createTab: mocks.createTab,
    closeTab: mocks.closeTab,
    registerWebview: mocks.registerWebview,
    connectTabHost: mocks.connect,
    disconnectTabHost: mocks.disconnect,
    executeTabRequest: async (
      _tab: string,
      connectionId: string,
      request: { requestId: string },
    ) => ({
      clientId: "desktop",
      connectionId,
      requestId: request.requestId,
      ok: true,
      result: {},
    }),
  },
}));
vi.mock("~/components/preview/usePreviewBridge", () => ({ usePreviewBridge: () => {} }));
vi.mock("./browserRecording", () => ({
  useActiveBrowserRecordingTabIds: () => new Set(),
  stopBrowserRecording: async () => null,
}));
vi.mock("./browserDefaults", () => ({
  useBrowserDefaults: () => ({ profileId: "fixture" }),
  resolveBrowserDefaults: async () => ({}),
  browserDefaultTabState: () => ({ zoomFactor: 1, colorScheme: "system" }),
}));
vi.mock("./previewWebviewConfigState", () => ({ usePreviewWebviewConfig: () => mocks.config }));
vi.mock("./openFileInPreview", () => ({ openUrlInPreview: () => {} }));
vi.mock("./previewRuntime", () => ({ rendersServerTabNatively: () => false }));

import { AppAtomRegistryProvider } from "~/rpc/atomRegistry";
import {
  applyPreviewServerSnapshot,
  beginPreviewSessionClose,
  resetPreviewStateForTests,
} from "~/previewStateStore";
import { ElectronBrowserHost } from "./ElectronBrowserHost";
import { previewRuntimeTabId } from "./previewRuntimeTabId";
import { acquireBrowserSurface, useBrowserSurfaceStore } from "./browserSurfaceStore";

let renderer: ReactTestRenderer | undefined;
afterEach(async () => {
  vi.useFakeTimers();
  await act(() => renderer?.unmount());
  renderer = undefined;
  await vi.advanceTimersByTimeAsync(0);
  vi.useRealTimers();
  resetPreviewStateForTests();
  useBrowserSurfaceStore.setState({ activityByTabId: {}, byTabId: {} });
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

it("keeps thread A's guest hosted and paintable when the preview switches to thread B", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("window", globalThis);
  // useBrowserLayoutZoomFactor listens for window resize.
  vi.stubGlobal("addEventListener", () => {});
  vi.stubGlobal("removeEventListener", () => {});
  vi.stubGlobal("navigator", { platform: "MacIntel" });
  vi.stubGlobal("requestAnimationFrame", () => 0);
  vi.stubGlobal("cancelAnimationFrame", () => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
  const threadRef = {
    environmentId: EnvironmentId.make("relay-fixture"),
    threadId: ThreadId.make("thread-a"),
  };
  const tabId = "tab-a";
  const runtimeTabId = previewRuntimeTabId(threadRef, tabId);
  applyPreviewServerSnapshot(threadRef, {
    ...threadRef,
    tabId,
    runtime: "desktop",
    navStatus: { _tag: "Idle" },
    canGoBack: false,
    canGoForward: false,
    updatedAt: "2026-10-15T00:00:00.000Z",
  });
  let onEvent!: (event: PreviewAutomationStreamEvent) => Promise<void>;
  let attached!: () => void;
  const ready = new Promise<void>((resolve) => {
    attached = resolve;
  });
  mocks.connect.mockImplementation(async () => {
    attached();
  });
  mocks.runCommand.mockImplementation(async (_registry, command, { input }) => {
    if (command === "register") return AsyncResult.success({ connectionId: "host-a" });
    if (command === "respond") return AsyncResult.success(undefined);
    onEvent = input.onEvent;
    return new Promise<void>((resolve) =>
      input.signal.addEventListener("abort", resolve, { once: true }),
    );
  });
  function ThreadView({ thread }: { thread: string }) {
    useEffect(() => {
      if (thread !== "thread-a") return;
      const surface = acquireBrowserSurface(runtimeTabId);
      surface.present({ x: 10, y: 10, width: 800, height: 600 }, true);
      return surface.release;
    }, [thread]);
    return <div>{thread}</div>;
  }
  const view = (thread: string) => (
    <AppAtomRegistryProvider>
      <ThreadView thread={thread} />
      <ElectronBrowserHost />
    </AppAtomRegistryProvider>
  );
  const guest = Object.assign(new EventTarget(), {
    isConnected: true,
    getWebContentsId: () => 41,
    focus: () => {},
  });
  await act(async () => {
    renderer = create(view("thread-a"), {
      createNodeMock: (element) =>
        element.type === "webview" ? guest : { scrollLeft: 0, scrollTop: 0, scrollTo: () => {} },
    });
  });
  await act(async () => {
    guest.dispatchEvent(new Event("dom-ready"));
    await ready;
  });
  expect(mocks.connect).toHaveBeenCalledOnce();
  await act(() => {
    renderer!.update(view("thread-b"));
  });
  expect(mocks.closeTab).not.toHaveBeenCalled();
  expect(mocks.connect).toHaveBeenCalledOnce();
  const wrapper = renderer!.root.findByProps({ "data-preview-viewport": runtimeTabId });
  expect(wrapper.props.style).toMatchObject({ left: 0, top: 0, zIndex: -1, visibility: "visible" });
  for (const operation of ["status", "snapshot"] as const) {
    await onEvent({
      type: "request",
      connectionId: "host-a",
      request: {
        requestId: operation,
        threadId: threadRef.threadId,
        tabId,
        operation,
        input: {},
        timeoutMs: 1000,
      },
    });
  }
  // Flush asynchronous request delivery and its response command.
  await act(async () => {});
  expect(
    mocks.runCommand.mock.calls
      .filter(([, command]) => command === "respond")
      .map(([, , args]) => args.input),
  ).toMatchObject([
    { requestId: "status", ok: true },
    { requestId: "snapshot", ok: true },
  ]);
  await act(() => renderer!.update(view("thread-a")));
  expect(mocks.connect).toHaveBeenCalledOnce();
  expect(mocks.closeTab).not.toHaveBeenCalled();
  await act(() => beginPreviewSessionClose(threadRef, tabId));
  expect(useBrowserSurfaceStore.getState().activityByTabId[runtimeTabId]).toBeUndefined();
  expect(renderer!.root.findAllByType("webview")).toHaveLength(0);
});
