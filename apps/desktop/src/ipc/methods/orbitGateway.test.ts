import { describe, expect, it } from "vite-plus/test";

import { resolveConnUrl } from "./orbitGateway.ts";

describe("resolveConnUrl", () => {
  it("keeps ordinary Conn paths below the prefix", () => {
    expect(resolveConnUrl("/me")?.pathname).toBe("/api/v1/conn/me");
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
