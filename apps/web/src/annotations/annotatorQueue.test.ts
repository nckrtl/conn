import { afterEach, describe, expect, it, vi } from "vite-plus/test";

import {
  annotationState,
  annotatorEndpointForPage,
  type AnnotatorRecord,
  buildAnnotationPrompt,
  clearDoneAnnotations,
  countAnnotations,
  normalizeAnnotatorServerUrl,
  openAnnotationCount,
  overlayBootstrapScript,
  overlayOptions,
  removeIdleAnnotations,
  waitingIdsToSend,
} from "./annotatorQueue";

const record = (
  id: string,
  number: number,
  extra: Partial<AnnotatorRecord> = {},
): AnnotatorRecord => ({
  id,
  number,
  comment: `Comment ${number}`,
  status: "todo",
  ...extra,
});

describe("annotatorEndpointForPage", () => {
  it("uses the page origin and the Orbit annotator path", () => {
    expect(annotatorEndpointForPage("https://shop.test/pricing?x=1")).toEqual({
      annotationsUrl: "https://shop.test/__orbit/annotator/annotations",
      injectUrl: "https://shop.test/__orbit/annotator/inject.js",
      origin: "shop.test",
    });
  });

  it("ignores pages that are not http(s)", () => {
    expect(annotatorEndpointForPage("about:blank")).toBeNull();
    expect(annotatorEndpointForPage("not a url")).toBeNull();
    expect(
      annotatorEndpointForPage("about:blank", "http://10.44.0.7:47821/annotations"),
    ).toBeNull();
  });

  it("uses a configured annotator server for every page", () => {
    expect(
      annotatorEndpointForPage("https://example.com/docs", "http://10.44.0.7:47821/annotations"),
    ).toEqual({
      annotationsUrl: "http://10.44.0.7:47821/annotations",
      injectUrl: "http://10.44.0.7:47821/inject.js",
      origin: "10.44.0.7:47821",
    });
  });

  it("falls back to the Orbit annotator when the configured server is not an http(s) URL", () => {
    expect(annotatorEndpointForPage("https://shop.test/", "ftp://host/annotations")).toEqual(
      annotatorEndpointForPage("https://shop.test/"),
    );
  });
});

describe("normalizeAnnotatorServerUrl", () => {
  it("accepts the printed URL with stray whitespace and trailing slashes", () => {
    expect(normalizeAnnotatorServerUrl("  http://10.44.0.7:47821/annotations/ ")).toBe(
      "http://10.44.0.7:47821/annotations",
    );
  });

  it("adds the annotations path to a bare server address", () => {
    expect(normalizeAnnotatorServerUrl("http://10.44.0.7:47821")).toBe(
      "http://10.44.0.7:47821/annotations",
    );
    expect(normalizeAnnotatorServerUrl("https://shop.test/__orbit/annotator/")).toBe(
      "https://shop.test/__orbit/annotator/annotations",
    );
  });

  it("rejects empty and non-http values", () => {
    expect(normalizeAnnotatorServerUrl("")).toBeNull();
    expect(normalizeAnnotatorServerUrl("10.44.0.7:47821")).toBeNull();
    expect(normalizeAnnotatorServerUrl("javascript:alert(1)")).toBeNull();
  });
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

  it("counts open annotations without the finished ones", () => {
    const counts = countAnnotations([
      record("a", 1),
      record("b", 2, { status: "in_progress" }),
      record("c", 3, { question: true }),
      record("d", 4, { status: "done" }),
    ]);
    expect(counts).toEqual({ waiting: 1, working: 1, question: 1, done: 1 });
    expect(openAnnotationCount(counts)).toBe(3);
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
  it("names the waiting annotations by number and the claim, complete and question calls", () => {
    const prompt = buildAnnotationPrompt({
      annotationsUrl: "https://shop.test/__orbit/annotator/annotations",
      annotations: [record("a", 1), record("b", 2, { status: "done" }), record("c", 3)],
    });
    expect(prompt).toContain("2 annotations are waiting (#1, #3)");
    expect(prompt).toContain(
      "curl -sS -X POST https://shop.test/__orbit/annotator/annotations/claim",
    );
    expect(prompt).toContain('"question":true');
    expect(prompt).toContain("never by id");
  });
});

describe("clearDoneAnnotations", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("deletes only finished annotations and counts what the server removed", async () => {
    const calls: string[] = [];
    vi.stubGlobal("fetch", (url: string, init: RequestInit) => {
      calls.push(`${init.method} ${url}`);
      return Promise.resolve(new Response(null, { status: url.endsWith("/gone") ? 404 : 200 }));
    });
    const removed = await clearDoneAnnotations("https://shop.test/__orbit/annotator/annotations", [
      record("open", 1),
      record("a b", 2, { status: "done" }),
      record("gone", 3, { status: "done" }),
      record("busy", 4, { status: "in_progress" }),
    ]);
    expect(calls).toEqual([
      "DELETE https://shop.test/__orbit/annotator/annotations/a%20b",
      "DELETE https://shop.test/__orbit/annotator/annotations/gone",
    ]);
    expect(removed).toBe(1);
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

  it("turns dictation off without a start URL", () => {
    expect(overlayOptions({ startUrl: "", stopUrl: "x" }).dictation).toEqual({ provider: "none" });
  });

  it("reuses an overlay the page already runs instead of loading a second copy", () => {
    const endpoint = annotatorEndpointForPage("https://shop.test/")!;
    const dictation = { startUrl: "", stopUrl: "" };
    const mounted: unknown[] = [];
    const page = {
      AgentAnnotation: { mountAnnotation: (options: unknown) => mounted.push(options) },
    } as Record<string, unknown>;
    const run = new Function(
      "window",
      "sessionStorage",
      "document",
      `return ${overlayBootstrapScript(endpoint, dictation)}`,
    );
    const storage = { setItem: () => undefined };
    const document = {
      createElement: () => {
        throw new Error("must not load a second copy");
      },
    };
    expect(run(page, storage, document)).toBe("reused");
    expect(mounted).toHaveLength(1);
  });
});

describe("removeIdleAnnotations", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("removes waiting, question and done annotations but keeps work in progress", async () => {
    const calls: string[] = [];
    vi.stubGlobal("fetch", (url: string) => {
      calls.push(url.split("/").pop() ?? "");
      return Promise.resolve(new Response(null, { status: 200 }));
    });
    const removed = await removeIdleAnnotations("https://shop.test/__orbit/annotator/annotations", [
      record("waiting", 1),
      record("question", 2, { question: true }),
      record("done", 3, { status: "done" }),
      record("busy", 4, { status: "in_progress" }),
    ]);
    expect(calls).toEqual(["waiting", "question", "done"]);
    expect(removed).toBe(3);
  });
});
