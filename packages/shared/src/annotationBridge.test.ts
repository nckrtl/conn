import { describe, expect, it } from "vite-plus/test";

import { annotationBelongsToOrigin, isAnnotationBridgeRequest } from "./annotationBridge.ts";

describe("isAnnotationBridgeRequest", () => {
  it("accepts the three operations", () => {
    expect(isAnnotationBridgeRequest({ requestId: "1", op: "list" })).toBe(true);
    expect(isAnnotationBridgeRequest({ requestId: "2", op: "submit", payload: { id: "a" } })).toBe(
      true,
    );
    expect(
      isAnnotationBridgeRequest({ requestId: "3", op: "remove", payload: { ids: ["a"] } }),
    ).toBe(true);
  });

  it("rejects other messages", () => {
    expect(isAnnotationBridgeRequest({ op: "list" })).toBe(false);
    expect(isAnnotationBridgeRequest({ requestId: "1", op: "claim" })).toBe(false);
    expect(isAnnotationBridgeRequest({ requestId: "1", op: "remove", payload: { ids: [1] } })).toBe(
      false,
    );
  });
});

describe("annotationBelongsToOrigin", () => {
  it("keeps only browser annotations of the same origin", () => {
    const origin = "https://app.test";
    expect(annotationBelongsToOrigin({ url: "https://app.test/a" }, origin)).toBe(true);
    expect(annotationBelongsToOrigin({ url: "https://other.test/a" }, origin)).toBe(false);
    expect(annotationBelongsToOrigin({ source: "device" }, origin)).toBe(false);
    expect(annotationBelongsToOrigin({ url: "not a url" }, origin)).toBe(false);
  });
});
