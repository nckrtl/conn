import { describe, expect, it } from "vite-plus/test";

import { resolveBrandName } from "./mobileBranding";

describe("resolveBrandName", () => {
  it("keeps a configured name", () => {
    expect(resolveBrandName("Conn")).toBe("Conn");
    expect(resolveBrandName("  Conn  ")).toBe("Conn");
  });

  it("treats a missing name as T3 Code", () => {
    expect(resolveBrandName(undefined)).toBeNull();
    expect(resolveBrandName(null)).toBeNull();
    expect(resolveBrandName("")).toBeNull();
    expect(resolveBrandName("   ")).toBeNull();
  });

  it("ignores the empty object iOS passes for a null config value", () => {
    expect(resolveBrandName({})).toBeNull();
    expect(resolveBrandName(["Conn"])).toBeNull();
    expect(resolveBrandName(1)).toBeNull();
  });
});
