import { describe, expect, it } from "vite-plus/test";

import { isAllowedConnQuery, resolveConnUrl } from "./orbitGateway.ts";

describe("resolveConnUrl", () => {
  it("keeps ordinary Conn paths below the prefix", () => {
    expect(resolveConnUrl("/me")?.pathname).toBe("/api/v1/conn/me");
    expect(resolveConnUrl("/instances/41/destroy")?.pathname).toBe(
      "/api/v1/conn/instances/41/destroy",
    );
    expect(resolveConnUrl("/profiles/1/settings")?.pathname).toBe(
      "/api/v1/conn/profiles/1/settings",
    );
    expect(resolveConnUrl("/")?.pathname).toBe("/api/v1/conn/");
  });

  it.each([
    "/../nodes",
    "/../../../v1/nodes",
    "/./me",
    "/..",
    "/%2e%2e/nodes",
    "/%2E%2E/nodes",
    "/.%2e/nodes",
    "/%2e/me",
    "/profiles/%2e%2e/%2e%2e/nodes",
    "/..%2fnodes",
    "/%2e%2e%2fnodes",
    "/%",
    "/%zz",
  ])("rejects %s", (path) => {
    expect(resolveConnUrl(path)).toBeNull();
  });

  it("allows dots inside a segment name", () => {
    expect(resolveConnUrl("/profiles/a..b")?.pathname).toBe("/api/v1/conn/profiles/a..b");
  });
});

describe("isAllowedConnQuery", () => {
  const get = (path: string, query?: Record<string, string>) => ({
    method: "GET" as const,
    path,
    ...(query ? { query } : {}),
  });

  it("lets a request without a query through on any path", () => {
    expect(isAllowedConnQuery(get("/me"))).toBe(true);
    expect(isAllowedConnQuery(get("/projects", {}))).toBe(true);
  });

  it("allows the name check's name and the project list's include_unavailable=1", () => {
    expect(isAllowedConnQuery(get("/projects/66/instances/check", { name: "pricing-page" }))).toBe(
      true,
    );
    expect(isAllowedConnQuery(get("/projects/66/instances/check", { name: "default" }))).toBe(true);
    expect(isAllowedConnQuery(get("/projects", { include_unavailable: "1" }))).toBe(true);
    expect(isAllowedConnQuery(get("/projects/66/branches", { query: "feature/Login" }))).toBe(true);
    expect(isAllowedConnQuery(get("/projects/66/branches", { query: "a".repeat(200) }))).toBe(true);
    expect(isAllowedConnQuery(get("/projects/66/branches"))).toBe(true);
  });

  it.each([
    ["another key", get("/projects/66/instances/check", { query: "x" })],
    ["an extra key", get("/projects/66/instances/check", { name: "a", limit: "5" })],
    ["a bad name", get("/projects/66/instances/check", { name: "Bad Name" })],
    ["a name over 63 characters", get("/projects/66/instances/check", { name: "a".repeat(64) })],
    ["an empty name", get("/projects/66/instances/check", { name: "" })],
    ["a non-numeric project", get("/projects/x/instances/check", { name: "a" })],
    ["include_unavailable=true", get("/projects", { include_unavailable: "true" })],
    ["include_unavailable=0", get("/projects", { include_unavailable: "0" })],
    [
      "include_unavailable with another key",
      get("/projects", { include_unavailable: "1", a: "b" }),
    ],
    ["a query on another path", get("/environments", { include_unavailable: "1" })],
    [
      "a branch search over 200 characters",
      get("/projects/66/branches", { query: "a".repeat(201) }),
    ],
    ["an empty branch search", get("/projects/66/branches", { query: "" })],
    ["a branch search with a control character", get("/projects/66/branches", { query: "a\nb" })],
    ["another key on branches", get("/projects/66/branches", { name: "main" })],
    ["an extra key on branches", get("/projects/66/branches", { query: "a", limit: "5" })],
    ["branches of a non-numeric project", get("/projects/x/branches", { query: "a" })],
    ["a POST", { method: "POST" as const, path: "/projects", query: { include_unavailable: "1" } }],
  ])("refuses %s", (_label, request) => {
    expect(isAllowedConnQuery(request)).toBe(false);
  });
});
