import { expect, it } from "vite-plus/test";

import type { AnnotatorRecord } from "./annotatorQueue";
import { applyAnnotationFetch } from "./useAnnotatorQueue";

const row = (id: string): AnnotatorRecord => ({
  id,
  number: 1,
  comment: "Pin",
  status: "todo",
});

it("keeps the last list when a later fetch fails", () => {
  const previous = [row("a")];
  expect(applyAnnotationFetch(null, null)).toEqual({ annotations: null, unreachable: true });
  expect(applyAnnotationFetch(previous, null)).toEqual({
    annotations: previous,
    unreachable: true,
  });
  const next = [row("b")];
  expect(applyAnnotationFetch(previous, next)).toEqual({ annotations: next, unreachable: false });
});
