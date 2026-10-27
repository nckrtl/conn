import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";
import { finishDraft, finishDraftAndMove } from "./actions";
import { startHostSession, type AnnotatorHost } from "./dictation-trigger";
import { annotationMode, annotations, draft, finishing } from "./state";
import { resetPinStore } from "./store";
import { configureAnnotationService } from "./sync";
import type { AnnotationTransport } from "./transport";
import type { Annotation, AnnotationDraft } from "./types";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((onResolve, onReject) => {
    resolve = onResolve;
    reject = onReject;
  });
  return { promise, resolve, reject };
}

function draftFor(id: string): AnnotationDraft {
  return {
    draftId: id,
    x: 10,
    y: 20,
    clientX: 10,
    clientY: 20,
    element: "button",
    elementPath: "main > button",
    boundingBox: { x: 0, y: 0, width: 10, height: 10 },
    isFixed: false,
    comment: "",
    url: "https://app.test/page",
    pathname: "/page",
  };
}

type SessionResult = { text?: string } | boolean;

function setup() {
  const stops = new Map<string, ReturnType<typeof deferred<SessionResult>>>();
  const dictationSession = vi.fn<NonNullable<AnnotatorHost["dictationSession"]>>(
    async (action, session) => {
      if (action !== "stop") return true;
      const stop = deferred<SessionResult>();
      stops.set(session, stop);
      return stop.promise;
    },
  );
  window.__ANNOTATOR_HOST__ = { dictation: async () => true, dictationSession };
  const submit = vi.fn(async (annotation: Annotation) => ({
    ...annotation,
    revision: 1,
    number: 1,
    status: "todo",
    createdAt: "2026-10-27T00:00:00.000Z",
  }));
  configureAnnotationService({
    list: async () => [],
    submit,
    remove: async () => {},
    subscribe: () => () => {},
  } satisfies AnnotationTransport);
  const stop = (session: string, result: SessionResult | Error) => {
    const pending = stops.get(session);
    if (!pending) throw new Error(`No stop for ${session}`);
    if (result instanceof Error) pending.reject(result);
    else pending.resolve(result);
  };
  const comments = () => submit.mock.calls.map(([annotation]) => annotation.comment);
  return { dictationSession, stop, comments };
}

beforeEach(() => {
  vi.stubGlobal("window", {
    location: { href: "https://app.test/page", origin: "https://app.test", pathname: "/page" },
    requestAnimationFrame: () => 1,
    cancelAnimationFrame: () => {},
    scrollX: 0,
    scrollY: 0,
  });
  annotationMode.value = true;
});
afterEach(() => {
  configureAnnotationService(undefined);
  resetPinStore();
  draft.value = null;
  finishing.value = [];
  annotations.value = [];
  annotationMode.value = false;
  vi.unstubAllGlobals();
});

it("opens the next box and starts its session without waiting for the previous stop", async () => {
  const { dictationSession, stop, comments } = setup();
  const first = draftFor("a");
  const next = draftFor("b");
  draft.value = first;

  const finished = finishDraftAndMove(first, "", "a", next);

  expect(draft.value).toBe(next);
  expect(finishing.value.map((entry) => entry.session)).toEqual(["a"]);
  await startHostSession("b", new AbortController().signal);
  expect(dictationSession.mock.calls.map(([action, session]) => [action, session])).toEqual([
    ["stop", "a"],
    ["start", "b"],
  ]);

  stop("a", { text: "Make it blue" });
  await finished;
  expect(comments()).toEqual(["Make it blue"]);
  expect(finishing.value).toEqual([]);
});

it("saves the transcript merged with the typed text", async () => {
  const { stop, comments } = setup();
  const finished = finishDraft(draftFor("a"), "Header:", "a");
  stop("a", { text: " too tall " });
  await finished;
  expect(comments()).toEqual(["Header: too tall"]);
  expect(annotations.value.map((annotation) => annotation.comment)).toEqual(["Header: too tall"]);
});

it("discards a box with no transcript and no typed text", async () => {
  const { stop, comments } = setup();
  const finished = finishDraft(draftFor("a"), "  ", "a");
  stop("a", { text: "" });
  await finished;
  expect(comments()).toEqual([]);
  expect(finishing.value).toEqual([]);
  expect(annotations.value).toEqual([]);
});

it.each([
  ["a cancelled or failed stop", false],
  ["an unreachable host", new Error("network")],
] as const)("keeps the typed text after %s, and drops an empty box", async (_case, result) => {
  const { stop, comments } = setup();
  const typed = finishDraft(draftFor("a"), "Too wide", "a");
  const empty = finishDraft(draftFor("b"), "", "b");
  stop("a", result);
  stop("b", result);
  await Promise.all([typed, empty]);
  expect(comments()).toEqual(["Too wide"]);
  expect(finishing.value).toEqual([]);
});

it("resolves several finishing boxes independently, in any order", async () => {
  const { stop, comments } = setup();
  const first = finishDraft(draftFor("a"), "", "a");
  const second = finishDraft(draftFor("b"), "", "b");
  expect(finishing.value.map((entry) => entry.session)).toEqual(["a", "b"]);

  stop("b", { text: "Second" });
  await second;
  expect(comments()).toEqual(["Second"]);
  expect(finishing.value.map((entry) => entry.session)).toEqual(["a"]);

  stop("a", { text: "First" });
  await first;
  expect(comments()).toEqual(["Second", "First"]);
  expect(finishing.value).toEqual([]);
});

it("still saves a box that finishes after annotation mode turns off", async () => {
  const { stop, comments } = setup();
  const source = draftFor("a");
  draft.value = source;
  const finished = finishDraft(source, "", "a");
  expect(draft.value).toBeNull();
  annotationMode.value = false;
  stop("a", { text: "Keep me" });
  await finished;
  expect(comments()).toEqual(["Keep me"]);
});
