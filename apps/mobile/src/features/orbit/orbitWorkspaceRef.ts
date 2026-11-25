import {
  OrbitGatewayError,
  SETTINGS_VERSION_CONFLICT,
  type OrbitGatewayClient,
  type OrbitGatewaySettings,
} from "@t3tools/client-runtime/orbit-gateway";
import * as Schema from "effect/Schema";

const isOrbitGatewayError = Schema.is(OrbitGatewayError);

/**
 * Conn: adds a project ref to one workspace of a profile, unless that workspace lists it already
 * or is gone. It writes against the version it read, so another device's change is never
 * overwritten; a version conflict reads the profile again once. Resolves the saved settings, or
 * null when nothing was written.
 */
export async function addProjectRefToProfileWorkspace(
  gateway: Pick<OrbitGatewayClient, "settings" | "replaceWorkspaces">,
  profileId: number,
  workspaceId: string,
  projectRef: string,
): Promise<OrbitGatewaySettings | null> {
  for (let attempt = 0; ; attempt++) {
    const settings = await gateway.settings(profileId);
    const target = settings.workspaces.find((workspace) => workspace.id === workspaceId);
    if (!target || (target.projectRefs ?? []).includes(projectRef)) return null;
    try {
      return await gateway.replaceWorkspaces(
        profileId,
        settings.version,
        settings.workspaces.map((workspace) =>
          workspace.id === workspaceId
            ? { ...workspace, projectRefs: [...(workspace.projectRefs ?? []), projectRef] }
            : workspace,
        ),
      );
    } catch (error) {
      const conflict = isOrbitGatewayError(error) && error.code === SETTINGS_VERSION_CONFLICT;
      if (!conflict || attempt >= 1) throw error;
    }
  }
}
