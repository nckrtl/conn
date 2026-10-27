import { beforeEach, describe, expect, it, vi } from "vite-plus/test";

import { relayLaravelToolbarMessage } from "./bridge";
import { useLaravelToolbarStore } from "./store";

const TAB = "tab";
const state = () => useLaravelToolbarStore.getState().byTabId[TAB];
const webview = { insertCSS: vi.fn(() => Promise.resolve("")) } as unknown as Element;
const message = (kind: string, data?: unknown) =>
  Object.assign(new Event("ipc-message"), { channel: "laravel-toolbar", args: [{ kind, data }] });

describe("relayLaravelToolbarMessage", () => {
  beforeEach(() => useLaravelToolbarStore.setState({ byTabId: {} }));

  it("starts the tab over with a page summary and leaves its details to be fetched", () => {
    relayLaravelToolbarMessage(TAB, webview, message("page", { request_id: "old", profiler: {} }));
    const row = { id: "r1", method: "GET", uri: "/dashboard", status_code: 200 };
    relayLaravelToolbarMessage(
      TAB,
      webview,
      message("page-summary", { request_id: "r1", history_row: row }),
    );
    expect(state()).toEqual({
      currentId: "r1",
      history: [{ row, receivedAt: expect.any(Number) }],
      details: {},
      selectedId: null,
    });
  });

  it("builds a row from the id when the summary has none", () => {
    relayLaravelToolbarMessage(
      TAB,
      webview,
      message("page-summary", { request_id: "r1", history_row: null }),
    );
    expect(state()?.history.map((entry) => entry.row)).toEqual([
      { id: "r1", method: "GET", uri: "/" },
    ]);
    expect(state()?.currentId).toBe("r1");
  });

  it("ignores a summary without a request id", () => {
    relayLaravelToolbarMessage(TAB, webview, message("page", { request_id: "r0", profiler: {} }));
    relayLaravelToolbarMessage(TAB, webview, message("page-summary", { history_row: { id: "x" } }));
    expect(state()?.currentId).toBe("r0");
  });

  it("adds a summary update from a later request to the history", () => {
    relayLaravelToolbarMessage(
      TAB,
      webview,
      message("page-summary", { request_id: "r1", history_row: null }),
    );
    relayLaravelToolbarMessage(
      TAB,
      webview,
      message("update", {
        request_id: "r2",
        history_row: { id: "r2", method: "POST", uri: "/api" },
      }),
    );
    expect(state()?.history.map((entry) => entry.row.id)).toEqual(["r1", "r2"]);
    expect(state()?.currentId).toBe("r1");
  });
});
