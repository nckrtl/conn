import { describe, expect, it } from "vite-plus/test";

import { orbitRouteSlug, orbitRouteSlugForBranch } from "./orbit.ts";

describe("orbitRouteSlugForBranch", () => {
  it("derives the route slug from T3's generated branch", () => {
    expect(orbitRouteSlugForBranch("t3/login-redirect")).toBe("login-redirect");
    expect(orbitRouteSlugForBranch("t3code/login-redirect")).toBe("login-redirect");
    expect(orbitRouteSlugForBranch("t3code/Fix_Login Redirect!")).toBe("fix-login-redirect");
    expect(orbitRouteSlugForBranch(`t3code/${"a".repeat(80)}`)).toHaveLength(63);
  });

  it("has no route slug while the branch is still temporary", () => {
    expect(orbitRouteSlugForBranch("t3/1a2b3c4d")).toBeNull();
    expect(orbitRouteSlugForBranch("t3code/1a2b3c4d")).toBeNull();
    expect(orbitRouteSlugForBranch("t3code/---")).toBeNull();
  });
});

describe("orbitRouteSlug", () => {
  const instanceName = "t3-1a2b3c4d";

  it("prefers T3's generated branch name", () => {
    expect(orbitRouteSlug({ branch: "t3/login-redirect", title: "Fix it", instanceName })).toBe(
      "login-redirect",
    );
  });

  it("falls back to the thread title for a placeholder branch name", () => {
    expect(
      orbitRouteSlug({
        branch: "t3/unknown",
        title: "Print Working Directory and Branch",
        instanceName,
      }),
    ).toBe("print-working-directory-and-branch");
    expect(
      orbitRouteSlug({
        branch: "t3/1a2b3c4d",
        title: "Fix the login redirect after a session times out",
        instanceName,
      }),
    ).toBe("fix-the-login-redirect-after-a-session");
  });

  it("keeps the branch or Instance name when the title does not help", () => {
    expect(orbitRouteSlug({ branch: "t3/unknown", title: "New thread", instanceName })).toBe(
      "unknown",
    );
    expect(orbitRouteSlug({ branch: "t3/1a2b3c4d", title: null, instanceName })).toBe(instanceName);
  });
});
