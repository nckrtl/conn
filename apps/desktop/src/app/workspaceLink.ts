/**
 * Decides what `t3code://workspace/<name>` does; the key matches `workspaceNameKey` in
 * `workspaces.logic.ts`. It focuses a window showing that workspace; a shorter name matches when
 * all matching windows show the same one ("DLF" → "DLF - Leden"). It never retargets a window.
 */

export interface ReportedWorkspace {
  readonly id: string | null;
  readonly name: string | null;
}

export interface WorkspaceWindowClaim {
  readonly windowId: number;
  /** Null until the renderer reports. A report replaces the launch workspace. */
  readonly reported: ReportedWorkspace | null;
  /**
   * The workspace token an extra window was opened for.
   * Undefined on the main window. Null means all projects.
   */
  readonly launchWorkspace: string | null | undefined;
}

export type WorkspaceLinkPlan =
  | { readonly action: "focus"; readonly windowId: number }
  | { readonly action: "open"; readonly workspace: string | null };

/** Same folding as `workspaceNameKey` in the web workspace list. */
function workspaceNameKey(name: string): string {
  return name
    .normalize("NFD")
    .replace(/\p{M}/gu, "")
    .toLocaleLowerCase()
    .replace(/[^\p{L}\p{N}]/gu, "");
}

/** Same words as `meansAllProjects` in the web workspace list. */
function meansAllProjects(token: string): boolean {
  return ["", "all", "allprojects", "none"].includes(workspaceNameKey(token));
}

function sameWorkspace(left: string, right: string): boolean {
  if (left === right) return true;
  const key = workspaceNameKey(left);
  return key.length > 0 && key === workspaceNameKey(right);
}

function showsAllProjects(claim: WorkspaceWindowClaim): boolean {
  if (claim.reported !== null) {
    return claim.reported.id === null && claim.reported.name === null;
  }
  return claim.launchWorkspace === null;
}

function showsWorkspace(claim: WorkspaceWindowClaim, token: string): boolean {
  if (claim.reported !== null) {
    if (claim.reported.id !== null && claim.reported.id === token) return true;
    return claim.reported.name !== null && sameWorkspace(claim.reported.name, token);
  }
  return typeof claim.launchWorkspace === "string" && sameWorkspace(claim.launchWorkspace, token);
}

/** Name key the window is showing. Null until a name exists. */
function claimWorkspaceKey(claim: WorkspaceWindowClaim): string | null {
  const name =
    claim.reported !== null
      ? claim.reported.name
      : typeof claim.launchWorkspace === "string"
        ? claim.launchWorkspace
        : null;
  if (name === null) return null;
  const key = workspaceNameKey(name);
  return key.length > 0 ? key : null;
}

/**
 * One workspace whose name starts with the link. Two windows of that same
 * workspace count as one. Two different workspaces count as no match.
 */
function uniquePrefixWindow(
  token: string,
  windows: readonly WorkspaceWindowClaim[],
): WorkspaceWindowClaim | undefined {
  const key = workspaceNameKey(token);
  if (key.length === 0) return undefined;
  const matches = windows.filter((claim) => {
    const nameKey = claimWorkspaceKey(claim);
    return nameKey !== null && nameKey.startsWith(key) && nameKey !== key;
  });
  if (matches.length === 0) return undefined;
  const keys = new Set(matches.map((claim) => claimWorkspaceKey(claim)));
  return keys.size === 1 ? matches[0] : undefined;
}

/** Workspace passed to a new window. Null shows every project. */
export function workspaceToOpen(token: string): string | null {
  return meansAllProjects(token) ? null : token;
}

/**
 * `windows` is in preference order: the focused window first.
 * The first match wins, so two windows on the same workspace raise one of them.
 */
export function planWorkspaceLink(
  token: string,
  windows: readonly WorkspaceWindowClaim[],
): WorkspaceLinkPlan {
  const match = windows.find((claim) =>
    meansAllProjects(token) ? showsAllProjects(claim) : showsWorkspace(claim, token),
  );
  if (match !== undefined) return { action: "focus", windowId: match.windowId };
  if (!meansAllProjects(token)) {
    const prefixed = uniquePrefixWindow(token, windows);
    if (prefixed !== undefined) return { action: "focus", windowId: prefixed.windowId };
  }
  return { action: "open", workspace: workspaceToOpen(token) };
}
