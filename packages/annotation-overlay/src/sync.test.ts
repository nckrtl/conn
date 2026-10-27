import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";
import { loadAnnotations, resetPinStore } from "./store";
import {
  clearSyncedAnnotations,
  configureAnnotationService,
  deleteSyncedAnnotation,
  fetchAnnotationSync,
  pushAnnotation,
  removalError,
  serviceConnection,
  UNAVAILABLE_MESSAGE,
} from "./sync";
import type { AnnotationTransport } from "./transport";
import type { Annotation } from "./types";

function record(overrides: Record<string, unknown>) {
  return {
    id: "a1",
    comment: "Fix",
    url: "https://app.test/page",
    pathname: "/page",
    x: 10,
    y: 20,
    revision: 1,
    number: 1,
    status: "todo",
    hasScreenshot: false,
    createdAt: "2026-10-27T00:00:00.000Z",
    ...overrides,
  };
}

function setup(records: unknown[] = []) {
  const transport = {
    list: vi.fn(async () => records),
    submit: vi.fn(async (annotation: Annotation) =>
      record({ ...annotation, revision: 1, number: 7, status: "todo" }),
    ),
    remove: vi.fn(async (_ids: ReadonlyArray<string>) => {}),
    subscribe: vi.fn(() => () => {}),
  } satisfies AnnotationTransport;
  configureAnnotationService(transport);
  return transport;
}

beforeEach(() => {
  vi.stubGlobal("window", {
    location: { href: "https://app.test/page", origin: "https://app.test", pathname: "/page" },
  });
});
afterEach(() => {
  configureAnnotationService(undefined);
  resetPinStore();
  vi.unstubAllGlobals();
});

it("maps server statuses and keeps progress details", async () => {
  setup([
    record({ id: "a1", status: "todo" }),
    record({ id: "a2", status: "in_progress", summary: "Working" }),
    record({ id: "a3", status: "in_progress", question: true, summary: "Which colour?" }),
    record({ id: "a4", status: "done", summary: "Done" }),
  ]);

  const sync = await fetchAnnotationSync();

  expect(serviceConnection.getSnapshot()).toBe("Connected");
  expect(sync.annotations.map((a) => [a.id, a.status])).toEqual([
    ["a1", "pending"],
    ["a2", "in_progress"],
    ["a3", "in_progress"],
    ["a4", "resolved"],
  ]);
  expect(sync.inProgressIds).toEqual(["a2", "a3"]);
  expect(sync.resolvedIds).toEqual(["a4"]);
  expect(loadAnnotations("/page").map((a) => a.id)).toEqual(["a1", "a2", "a3"]);
  expect(loadAnnotations("/page").find((a) => a.id === "a3")).toMatchObject({
    question: true,
    summary: "Which colour?",
  });
});

it("drops a stale revision", async () => {
  const records: unknown[] = [record({ revision: 5, comment: "New" })];
  setup(records);
  await fetchAnnotationSync();
  records.splice(0, 1, record({ revision: 4, comment: "Old" }));

  await fetchAnnotationSync();

  expect(loadAnnotations("/page")[0]?.comment).toBe("New");
});

it("shows only browser annotations of this site", async () => {
  setup([
    record({ id: "mine" }),
    record({ id: "other-site", url: "https://other.test/page" }),
    record({ id: "device", source: "device", url: undefined, pathname: "device/mac/sim" }),
  ]);

  const sync = await fetchAnnotationSync();

  expect(sync.annotations.map((a) => a.id)).toEqual(["mine"]);
});

it("removes a pin when the server no longer lists it", async () => {
  const records: unknown[] = [record({ id: "a1" }), record({ id: "a2" })];
  setup(records);
  await fetchAnnotationSync();
  records.splice(1, 1);

  const sync = await fetchAnnotationSync();

  expect(sync.resolvedIds).toContain("a2");
  expect(loadAnnotations("/page").map((a) => a.id)).toEqual(["a1"]);
});

it("submits a capture and keeps the server number", async () => {
  const transport = setup();

  const stored = await pushAnnotation({
    id: "new-1",
    comment: "Hello",
    x: 1,
    y: 2,
    element: "button",
    elementPath: "main > button",
    timestamp: 1,
    status: "pending",
    syncError: "old",
  });

  expect(transport.submit).toHaveBeenCalledOnce();
  expect(stored).toMatchObject({ id: "new-1", number: 7, status: "pending" });
});

it("marks a submission failed when the page has no transport", async () => {
  configureAnnotationService(undefined);

  const stored = await pushAnnotation({
    id: "new-1",
    comment: "Hello",
    x: 1,
    y: 2,
    element: "button",
    elementPath: "main > button",
    timestamp: 1,
  });

  expect(serviceConnection.getSnapshot()).toBe("Unavailable");
  expect(stored).toMatchObject({ delivery: "error", syncError: UNAVAILABLE_MESSAGE });
});

it("deletes a stored annotation through the transport", async () => {
  const transport = setup([record({ id: "a1" }), record({ id: "a2" })]);
  await fetchAnnotationSync();

  expect(await deleteSyncedAnnotation("a1")).toBe(true);

  expect(transport.remove).toHaveBeenCalledExactlyOnceWith(["a1"]);
  expect(loadAnnotations("/page").map((a) => a.id)).toEqual(["a2"]);
  await fetchAnnotationSync();
  expect(loadAnnotations("/page").map((a) => a.id)).toEqual(["a2"]);
});

it("clears only the current page's annotations", async () => {
  const transport = setup([
    record({ id: "here" }),
    record({ id: "there", pathname: "/other", url: "https://app.test/other" }),
  ]);
  await fetchAnnotationSync();

  expect(await clearSyncedAnnotations("/page")).toBe(true);

  expect(transport.remove).toHaveBeenCalledExactlyOnceWith(["here"]);
});

it("keeps the pin and reports when the server cannot remove it", async () => {
  const transport = setup([record({ id: "a1" })]);
  await fetchAnnotationSync();
  transport.remove.mockRejectedValueOnce(new Error("offline"));

  expect(await deleteSyncedAnnotation("a1")).toBe(false);

  expect(removalError.getSnapshot()).toBe("Could not delete the annotation. Try again.");
  expect(loadAnnotations("/page").map((a) => a.id)).toEqual(["a1"]);
});
