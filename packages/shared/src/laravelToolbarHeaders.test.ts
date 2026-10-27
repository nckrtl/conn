import { describe, expect, it } from "vite-plus/test";

import { decodeToolbarHeaders, minimalToolbarRow } from "./laravelToolbarHeaders.ts";

const base64 = (value: unknown) =>
  btoa(String.fromCharCode(...new TextEncoder().encode(JSON.stringify(value))));
const base64Url = (value: unknown) =>
  base64(value).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

describe("decodeToolbarHeaders", () => {
  it("reads a full payload, also URL-safe base64 without padding", () => {
    const data = { request_id: "abc", request: { uri: "/é?x=>>>" } };
    expect(decodeToolbarHeaders(base64(data), null)).toEqual({ kind: "full", data });
    expect(decodeToolbarHeaders(base64Url(data), null)).toEqual({ kind: "full", data });
  });

  it("prefers the full payload over the summary", () => {
    const data = { request_id: "abc" };
    const summary = base64({ request_id: "abc", history_row: { id: "abc" } });
    expect(decodeToolbarHeaders(base64(data), summary)?.kind).toBe("full");
  });

  it("falls back to the summary, with or without a usable row", () => {
    const row = { id: "abc", method: "GET", uri: "/api" };
    expect(decodeToolbarHeaders(null, base64({ request_id: "abc", history_row: row }))).toEqual({
      kind: "summary",
      id: "abc",
      row,
    });
    expect(decodeToolbarHeaders(null, base64({ request_id: "abc", history_row: [1] }))).toEqual({
      kind: "summary",
      id: "abc",
      row: null,
    });
  });

  it("ignores garbage", () => {
    expect(decodeToolbarHeaders(null, null)).toBeNull();
    expect(decodeToolbarHeaders("not base64 json", "%%%")).toBeNull();
    expect(decodeToolbarHeaders(base64([1, 2]), null)).toBeNull();
    expect(decodeToolbarHeaders(base64({ request_id: 7 }), null)).toBeNull();
    expect(decodeToolbarHeaders(null, base64({ history_row: { id: "a" } }))).toBeNull();
    // Invalid UTF-8 is rejected, not replaced.
    expect(decodeToolbarHeaders(btoa("\xff\xfe"), null)).toBeNull();
  });
});

describe("minimalToolbarRow", () => {
  it("uses the request's method and path", () => {
    expect(minimalToolbarRow("r1", { method: "post", url: "https://app.test/a/b?c=1#h" })).toEqual({
      id: "r1",
      method: "POST",
      uri: "/a/b?c=1",
    });
  });

  it("falls back to GET / without a usable request", () => {
    expect(minimalToolbarRow("r1")).toEqual({ id: "r1", method: "GET", uri: "/" });
    expect(minimalToolbarRow("r1", { url: "not a url" })).toEqual({
      id: "r1",
      method: "GET",
      uri: "/",
    });
  });
});
