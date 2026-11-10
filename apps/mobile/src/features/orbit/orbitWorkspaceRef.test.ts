import {
  OrbitGatewayError,
  SETTINGS_VERSION_CONFLICT,
  type OrbitGatewaySettings,
  type OrbitGatewayWorkspace,
} from "@t3tools/client-runtime/orbit-gateway";
import { describe, expect, it } from "vite-plus/test";

import { addProjectRefToProfileWorkspace } from "./orbitWorkspaceRef";

const workspace = (id: string, projectRefs: string[]): OrbitGatewayWorkspace => ({
  id,
  name: id,
  color: "blue",
  icon: null,
  projectRefs,
});

/** A profile whose version moves on when another device writes between a read and a write. */
function profile(initial: OrbitGatewayWorkspace[], otherWrites: OrbitGatewayWorkspace[][] = []) {
  let version = 1;
  let workspaces = initial;
  const writes: Array<{ version: number; workspaces: readonly OrbitGatewayWorkspace[] }> = [];
  const settings = (): OrbitGatewaySettings => ({
    profileId: 1,
    version,
    workspaces,
    updatedAt: "",
    document: {},
    sections: null,
  });
  const gateway = {
    settings: async () => settings(),
    replaceWorkspaces: async (
      _profileId: number,
      sent: number,
      next: readonly OrbitGatewayWorkspace[],
    ) => {
      const other = otherWrites.shift();
      if (other) {
        workspaces = other;
        version += 1;
      }
      if (sent !== version) {
        throw new OrbitGatewayError({
          code: SETTINGS_VERSION_CONFLICT,
          message: "stale",
          status: 409,
          details: {},
        });
      }
      writes.push({ version: sent, workspaces: next });
      workspaces = [...next];
      version += 1;
      return settings();
    },
  };
  return { gateway, writes, current: () => workspaces };
}

describe("addProjectRefToProfileWorkspace", () => {
  it("adds the ref to the chosen workspace only", async () => {
    const { gateway, current } = profile([workspace("a", ["x:1"]), workspace("b", [])]);
    await addProjectRefToProfileWorkspace(gateway, 1, "a", "clone:p");
    expect(current()).toEqual([workspace("a", ["x:1", "clone:p"]), workspace("b", [])]);
  });

  it("writes nothing when the workspace lists the ref or is gone", async () => {
    const { gateway, writes } = profile([workspace("a", ["clone:p"])]);
    expect(await addProjectRefToProfileWorkspace(gateway, 1, "a", "clone:p")).toBeNull();
    expect(await addProjectRefToProfileWorkspace(gateway, 1, "gone", "clone:p")).toBeNull();
    expect(writes).toEqual([]);
  });

  it("keeps another device's change on a version conflict", async () => {
    const { gateway, current } = profile(
      [workspace("a", [])],
      [[workspace("a", []), workspace("new", [])]],
    );
    await addProjectRefToProfileWorkspace(gateway, 1, "a", "clone:p");
    expect(current()).toEqual([workspace("a", ["clone:p"]), workspace("new", [])]);
  });
});
