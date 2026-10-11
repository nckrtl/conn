import { beforeEach, describe, expect, it } from "vite-plus/test";

import { MAX_HISTORY, useLaravelToolbarStore } from "./store";

const TAB = "tab";
const state = () => useLaravelToolbarStore.getState().byTabId[TAB]!;

describe("laravel toolbar store", () => {
  beforeEach(() => useLaravelToolbarStore.setState({ byTabId: {} }));

  it("starts over on a page load", () => {
    useLaravelToolbarStore.getState().receivePage(TAB, {
      request_id: "r1",
      profiler: { stages: [] },
      request: { method: "GET", uri: "/" },
    });
    expect(state().currentId).toBe("r1");
    expect(state().history.map((entry) => entry.row.id)).toEqual(["r1"]);
  });

  it("keeps the server's row for the page, with its follow-up mark", () => {
    useLaravelToolbarStore.getState().receivePage(TAB, {
      request_id: "r2",
      profiler: {},
      request_history: [
        { id: "r1", method: "GET", uri: "/old", status_code: 302 },
        { id: "r2", method: "GET", uri: "/new", follow_up: "redirect" },
      ],
    });
    expect(state().history.map((entry) => entry.row.follow_up ?? null)).toEqual([null, "redirect"]);
  });

  it("adds a summary row for a later request", () => {
    useLaravelToolbarStore.getState().receivePage(TAB, { request_id: "r1", profiler: {} });
    useLaravelToolbarStore.getState().receiveUpdate(TAB, {
      request_id: "r2",
      history_row: { id: "r2", method: "GET", uri: "/api" },
    });
    expect(state().history.map((entry) => entry.row.id)).toEqual(["r1", "r2"]);
    expect(state().currentId).toBe("r1");
  });

  it("replaces the state when an Inertia visit sends the history", () => {
    useLaravelToolbarStore.getState().receivePage(TAB, { request_id: "r1", profiler: {} });
    useLaravelToolbarStore.getState().receiveUpdate(TAB, {
      request_id: "r3",
      selected_request_id: "r3",
      request_history: [
        { id: "r1", method: "GET", uri: "/" },
        { id: "r3", method: "GET", uri: "/download" },
      ],
    });
    expect(state().currentId).toBe("r3");
    expect(state().history.map((entry) => entry.row.id)).toEqual(["r1", "r3"]);
  });
  it("makes a request sent from the API panel current and keeps the earlier ones", () => {
    const store = useLaravelToolbarStore.getState();
    store.receiveRequest(TAB, { id: "a", method: "GET", uri: "/api/users" }, { request_id: "a" });
    store.receiveRequest(TAB, { id: "b", method: "POST", uri: "/api/users" }, null);
    expect(state().currentId).toBe("b");
    expect(state().history.map((entry) => entry.row.id)).toEqual(["a", "b"]);
    expect(Object.keys(state().details)).toEqual(["a"]);
  });

  it("keeps the newest requests and drops the payloads of the ones it forgets", () => {
    const store = useLaravelToolbarStore.getState();
    const total = MAX_HISTORY + 50;
    for (let index = 0; index < total; index += 1) {
      store.receiveRequest(
        TAB,
        { id: `r${index}`, method: "GET", uri: `/api/${index}` },
        { request_id: `r${index}` },
      );
    }
    const ids = state().history.map((entry) => entry.row.id);
    expect(ids).toHaveLength(MAX_HISTORY);
    expect(ids[0]).toBe("r50");
    expect(ids.at(-1)).toBe(`r${total - 1}`);
    expect(Object.keys(state().details).toSorted()).toEqual(ids.toSorted());
  });

  it("keeps the page's own request when the cap would drop it", () => {
    const store = useLaravelToolbarStore.getState();
    store.receivePage(TAB, { request_id: "page", profiler: {} });
    for (let index = 0; index < MAX_HISTORY + 5; index += 1) {
      store.receiveUpdate(TAB, {
        request_id: `x${index}`,
        profiler: {},
        history_row: { id: `x${index}`, method: "GET", uri: "/x" },
      });
    }
    expect(state().currentId).toBe("page");
    expect(state().history).toHaveLength(MAX_HISTORY);
    expect(state().history.some((entry) => entry.row.id === "page")).toBe(true);
    expect(state().details.page).toBeDefined();
    expect(Object.keys(state().details)).toHaveLength(MAX_HISTORY);
  });

  it("drops the payloads of cleared requests", () => {
    const store = useLaravelToolbarStore.getState();
    store.receiveRequest(TAB, { id: "a", method: "GET", uri: "/a" }, { request_id: "a" });
    store.receiveRequest(TAB, { id: "b", method: "GET", uri: "/b" }, { request_id: "b" });
    store.select(TAB, "a");
    store.clearHistory(TAB);
    expect(state().history.map((entry) => entry.row.id)).toEqual(["b"]);
    expect(Object.keys(state().details)).toEqual(["b"]);
    expect(state().selectedId).toBeNull();
  });

  it("drops the payloads of requests an Inertia history replaces", () => {
    const store = useLaravelToolbarStore.getState();
    store.receiveRequest(TAB, { id: "a", method: "GET", uri: "/a" }, { request_id: "a" });
    store.receiveUpdate(TAB, {
      request_id: "c",
      request_history: [{ id: "c", method: "GET", uri: "/c" }],
    });
    expect(Object.keys(state().details)).toEqual([]);
  });
});
