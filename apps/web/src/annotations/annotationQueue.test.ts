import { type AnnotationRecord, ProjectId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  annotationState,
  buildAnnotationPrompt,
  countAnnotations,
  hostDictationUrls,
  overlayOptions,
  waitingIdsToSend,
} from "./annotationQueue";

const record = (
  id: string,
  number: number,
  extra: Partial<AnnotationRecord> = {},
): AnnotationRecord => ({
  id,
  projectId: ProjectId.make("project"),
  number,
  revision: number,
  comment: `Comment ${number}`,
  status: "todo",
  hasScreenshot: false,
  createdAt: "2026-10-27T00:00:00.000Z",
  ...extra,
});

describe("annotation states", () => {
  it("maps server records to queue states", () => {
    expect(annotationState(record("a", 1))).toBe("waiting");
    expect(annotationState(record("a", 1, { question: true, summary: "Which URL?" }))).toBe(
      "question",
    );
    expect(annotationState(record("a", 1, { status: "in_progress" }))).toBe("working");
    expect(annotationState(record("a", 1, { status: "done" }))).toBe("done");
  });

  it("counts each state", () => {
    expect(
      countAnnotations([
        record("a", 1),
        record("b", 2, { status: "in_progress" }),
        record("c", 3, { question: true }),
        record("d", 4, { status: "done" }),
      ]),
    ).toEqual({ waiting: 1, working: 1, question: 1, done: 1 });
  });
});

describe("waitingIdsToSend", () => {
  const annotations = [record("a", 1), record("b", 2), record("q", 3, { question: true })];

  it("sends nothing unless watching and idle", () => {
    expect(
      waitingIdsToSend({ watching: false, threadIdle: true, annotations, lastSentIds: [] }),
    ).toEqual([]);
    expect(
      waitingIdsToSend({ watching: true, threadIdle: false, annotations, lastSentIds: [] }),
    ).toEqual([]);
  });

  it("sends every waiting annotation but never a question", () => {
    expect(
      waitingIdsToSend({ watching: true, threadIdle: true, annotations, lastSentIds: [] }),
    ).toEqual(["a", "b"]);
  });

  it("does not prompt again for annotations it already sent", () => {
    expect(
      waitingIdsToSend({ watching: true, threadIdle: true, annotations, lastSentIds: ["a", "b"] }),
    ).toEqual([]);
  });

  it("prompts again when a new annotation arrives", () => {
    expect(
      waitingIdsToSend({
        watching: true,
        threadIdle: true,
        annotations: [...annotations, record("c", 4)],
        lastSentIds: ["a", "b"],
      }),
    ).toEqual(["a", "b", "c"]);
  });
});

describe("buildAnnotationPrompt", () => {
  it("names the waiting annotations by number and the tools that work the queue", () => {
    const prompt = buildAnnotationPrompt([
      record("a", 1),
      record("b", 2, { status: "done" }),
      record("c", 3),
    ]);
    expect(prompt).toContain("2 annotations are waiting (#1, #3)");
    for (const tool of ["annotations_claim", "annotations_complete", "annotations_release"])
      expect(prompt).toContain(tool);
    expect(prompt).toContain("end your turn");
    expect(prompt).toContain("orchestrator");
    expect(prompt).toContain("never by id");
    expect(prompt).not.toMatch(/https?:\/\//);
  });
});

describe("overlay options", () => {
  it("starts and stops the desktop dictation app by POST", () => {
    expect(
      overlayOptions({
        startUrl: " http://127.0.0.1:12321/dictate ",
        stopUrl: "http://127.0.0.1:12321/dictate-stop",
      }),
    ).toEqual({
      floatingControl: false,
      dictation: {
        provider: "post",
        postUrl: "http://127.0.0.1:12321/dictate",
        stopUrl: "http://127.0.0.1:12321/dictate-stop",
        autoStart: true,
      },
    });
  });

  it("lets the desktop send dictation, so the page never gets the URLs", () => {
    const dictation = {
      startUrl: "http://127.0.0.1:12321/dictate",
      stopUrl: "http://127.0.0.1:12321/dictate-stop",
    };
    expect(overlayOptions(dictation, "host")).toEqual({
      floatingControl: false,
      dictation: { provider: "host", autoStart: true, stopOnNextElement: true },
    });
    expect(overlayOptions({ ...dictation, stopUrl: " " }, "host").dictation).toEqual({
      provider: "host",
      autoStart: true,
      stopOnNextElement: false,
    });
  });

  it("turns dictation off without a start URL", () => {
    expect(overlayOptions({ startUrl: "", stopUrl: "x" }).dictation).toEqual({ provider: "none" });
    expect(overlayOptions({ startUrl: "", stopUrl: "x" }, "host").dictation).toEqual({
      provider: "none",
    });
  });
});

describe("hostDictationUrls", () => {
  it("registers trimmed http(s) URLs and nothing without a start URL", () => {
    expect(
      hostDictationUrls({
        startUrl: " http://127.0.0.1:12321/dictate ",
        stopUrl: "http://127.0.0.1:12321/dictate-stop",
      }),
    ).toEqual({
      startUrl: "http://127.0.0.1:12321/dictate",
      stopUrl: "http://127.0.0.1:12321/dictate-stop",
    });
    expect(hostDictationUrls({ startUrl: "", stopUrl: "http://127.0.0.1:1/x" })).toEqual({
      startUrl: null,
      stopUrl: null,
    });
    expect(
      hostDictationUrls({ startUrl: "http://127.0.0.1:1/x", stopUrl: "file:///etc/passwd" }),
    ).toEqual({ startUrl: "http://127.0.0.1:1/x", stopUrl: null });
  });
});
