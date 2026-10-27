import { afterEach, expect, it, vi } from "vite-plus/test";
import { connTransport } from "./transport";

afterEach(() => vi.unstubAllGlobals());

it("is absent when the page environment provides no annotations", () => {
  vi.stubGlobal("window", {});
  expect(connTransport()).toBeUndefined();
});

it("sends the capture fields only", async () => {
  const conn = {
    list: vi.fn(async () => []),
    submit: vi.fn(async (capture: unknown) => capture),
    remove: vi.fn(async () => {}),
    subscribe: vi.fn(() => () => {}),
  };
  vi.stubGlobal("window", { __CONN_ANNOTATIONS__: conn });

  await connTransport()?.submit({
    id: "a1",
    comment: "Fix",
    x: 1,
    y: 2,
    element: "button",
    elementPath: "main > button",
    timestamp: 3,
    status: "pending",
    delivery: "error",
    syncError: "offline",
    number: 4,
    revision: 5,
    summary: "s",
    question: true,
    screenshot: "data:image/jpeg;base64,AAAA",
  });

  expect(conn.submit).toHaveBeenCalledExactlyOnceWith({
    id: "a1",
    comment: "Fix",
    x: 1,
    y: 2,
    element: "button",
    elementPath: "main > button",
    timestamp: 3,
    screenshot: "data:image/jpeg;base64,AAAA",
    source: "browser",
  });
});
