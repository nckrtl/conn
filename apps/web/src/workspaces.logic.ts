import type { EnvironmentMachineKind } from "@t3tools/contracts";

/**
 * Workspaces: named sets of sidebar projects, shown as a rail beside the
 * thread sidebar. Selecting one scopes the sidebar to its projects. They live
 * only in this client (localStorage); see workspaceStore.ts.
 */

export const WORKSPACE_COLORS = [
  "slate",
  "red",
  "orange",
  "amber",
  "lime",
  "green",
  "teal",
  "cyan",
  "sky",
  "blue",
  "violet",
  "pink",
] as const;
export type WorkspaceColor = (typeof WORKSPACE_COLORS)[number];

export interface Workspace {
  readonly id: string;
  readonly name: string;
  /** Logical sidebar project keys (SidebarProjectSnapshot.projectKey). */
  readonly projectKeys: readonly string[];
  /** Explicit environment-scoped selections; projectKeys keeps legacy selections. */
  readonly projectRefs?: readonly string[];
  readonly color: WorkspaceColor;
  /** A name from WORKSPACE_ICON_NAMES, or null to show the name's first letter. */
  readonly icon: string | null;
  /** An uploaded picture (a small data URL) shown instead of the icon or letter. */
  readonly image?: string | null;
}

/** Longest image data URL a workspace keeps: a 96px square is far below it. */
export const WORKSPACE_IMAGE_MAX_CHARS = 200_000;

/** True for an image data URL a workspace may keep (PNG, JPEG or WebP, base64). */
export function isWorkspaceImage(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length <= WORKSPACE_IMAGE_MAX_CHARS &&
    /^data:image\/(png|jpeg|webp);base64,[A-Za-z0-9+/]+=*$/.test(value)
  );
}

export interface WorkspaceProject {
  readonly projectKey: string;
  readonly displayName: string;
  /** The project's environment-scoped refs ("<environmentId>:<projectId>"). */
  readonly refs: readonly string[];
  /** The connections (environments) the project lives on. */
  readonly connections?: readonly WorkspaceConnection[];
}

/** A connection a project lives on, as the workspace editor shows it. */
export interface WorkspaceConnection {
  readonly environmentId: string;
  readonly label: string;
  readonly kind: EnvironmentMachineKind;
  /** The primary connection: the machine this app talks to first. */
  readonly primary: boolean;
}

export interface WorkspaceConnectionSection<P extends WorkspaceProject> {
  /** Null holds projects with no known connection (for example one that is offline now). */
  readonly connection: WorkspaceConnection | null;
  readonly projects: readonly P[];
}

/**
 * Groups projects under the connections they live on: this Mac first, then the
 * others by label, then projects with no known connection. A project on two
 * connections appears under both.
 */
export function groupProjectsByConnection<P extends WorkspaceProject>(
  projects: readonly P[],
): WorkspaceConnectionSection<P>[] {
  const sections = new Map<string, { connection: WorkspaceConnection; projects: P[] }>();
  const unknown: P[] = [];
  for (const project of projects) {
    const connections = project.connections ?? [];
    if (connections.length === 0) unknown.push(project);
    for (const connection of connections) {
      const section = sections.get(connection.environmentId) ?? { connection, projects: [] };
      section.projects.push(project);
      sections.set(connection.environmentId, section);
    }
  }
  const ordered: WorkspaceConnectionSection<P>[] = [...sections.values()].sort(
    (a, b) =>
      Number(b.connection.primary) - Number(a.connection.primary) ||
      a.connection.label.localeCompare(b.connection.label),
  );
  return unknown.length > 0 ? [...ordered, { connection: null, projects: unknown }] : ordered;
}

/**
 * The environment-scoped project refs a workspace covers, or null for all
 * projects: what new threads may use while it is selected.
 */
export function workspaceProjectRefs(
  workspace: Workspace | null,
  projects: readonly WorkspaceProject[],
): ReadonlySet<string> | null {
  if (workspace === null) return null;
  const keys = new Set(workspace.projectKeys);
  return new Set([
    ...(workspace.projectRefs ?? []),
    ...projects.filter((p) => keys.has(p.projectKey)).flatMap((p) => p.refs),
  ]);
}

/** Folds case and diacritics and keeps letters and digits, the way Rooms matches names. */
export function workspaceNameKey(name: string): string {
  return name
    .normalize("NFD")
    .replace(/\p{M}/gu, "")
    .toLocaleLowerCase()
    .replace(/[^\p{L}\p{N}]/gu, "");
}

/** The letter a workspace shows without an icon: the first letter or digit of its name. */
export function workspaceLetter(name: string): string {
  const match = /[\p{L}\p{N}]/u.exec(name);
  return match ? match[0].toLocaleUpperCase() : "?";
}

/**
 * The workspace a request names, by id or by name (compared like Rooms does).
 * A shorter name matches when exactly one workspace name starts with it,
 * so "DLF" selects "DLF - Leden".
 * Null when no workspace, or more than one, matches.
 */
export function findWorkspace(
  workspaces: readonly Workspace[],
  idOrName: string,
): Workspace | null {
  const byId = workspaces.find((workspace) => workspace.id === idOrName);
  if (byId) return byId;
  const key = workspaceNameKey(idOrName);
  if (key.length === 0) return null;
  const exact = workspaces.filter((workspace) => workspaceNameKey(workspace.name) === key);
  if (exact.length === 1) return exact[0]!;
  if (exact.length > 1) return null;
  const prefixed = workspaces.filter((workspace) =>
    workspaceNameKey(workspace.name).startsWith(key),
  );
  return prefixed.length === 1 ? prefixed[0]! : null;
}

/** Words that mean "no workspace": show every project. */
export function meansAllProjects(idOrName: string): boolean {
  return ["", "all", "allprojects", "none"].includes(workspaceNameKey(idOrName));
}

/**
 * Picks a color for a new workspace: the first palette color no workspace
 * uses yet, else the palette cycles.
 */
export function nextWorkspaceColor(workspaces: readonly Workspace[]): WorkspaceColor {
  const used = new Set(workspaces.map((workspace) => workspace.color));
  return (
    WORKSPACE_COLORS.find((color) => !used.has(color)) ??
    WORKSPACE_COLORS[workspaces.length % WORKSPACE_COLORS.length]!
  );
}

/**
 * The environment-scoped project refs ("<environmentId>:<projectId>") the
 * sidebar shows, given the active workspace and the sidebar's own
 * project filter (empty means no filter). Null means every project.
 */
export function resolveScopedProjectKeys<
  G extends {
    readonly projectKey: string;
    readonly memberProjectRefs: readonly {
      readonly environmentId: string;
      readonly projectId: string;
    }[];
  },
>(input: {
  readonly projectGroups: readonly G[];
  readonly workspace: Workspace | null;
  readonly scopedProjectGroups: readonly G[];
}): ReadonlySet<string> | null {
  const { projectGroups, workspace, scopedProjectGroups } = input;
  if (workspace === null && scopedProjectGroups.length === 0) return null;
  const inWorkspace = workspace === null ? null : new Set<string>(workspace.projectKeys);
  const refs = new Set(workspace?.projectRefs ?? []);
  const groups = scopedProjectGroups.length === 0 ? projectGroups : scopedProjectGroups;
  return new Set(
    groups.flatMap((group) =>
      group.memberProjectRefs
        .filter(
          (ref) =>
            inWorkspace === null ||
            inWorkspace.has(group.projectKey) ||
            refs.has(`${ref.environmentId}:${ref.projectId}`),
        )
        .map((ref) => `${ref.environmentId}:${ref.projectId}`),
    ),
  );
}

/** Trims a draft workspace; throws a readable error when it can't be saved. */
export function validateWorkspaceDraft(draft: {
  readonly name: string;
  readonly projectKeys: readonly string[];
  readonly projectRefs?: readonly string[];
  readonly color: string;
  readonly icon: string | null;
  readonly image?: string | null;
}): {
  name: string;
  projectKeys: string[];
  projectRefs?: string[];
  color: WorkspaceColor;
  icon: string | null;
  image: string | null;
} {
  const name = draft.name.trim().replace(/\s+/g, " ");
  if (name.length === 0) throw new Error("Give the workspace a name.");
  if (name.length > 40) throw new Error("Keep the name to 40 characters.");
  if (meansAllProjects(name)) throw new Error(`"${name}" is reserved for all projects.`);
  if (!WORKSPACE_COLORS.includes(draft.color as WorkspaceColor)) throw new Error("Pick a color.");
  const image = draft.image ?? null;
  if (image !== null && !isWorkspaceImage(image)) throw new Error("That image can't be used.");
  return {
    name,
    projectKeys: [...new Set(draft.projectKeys)],
    ...(draft.projectRefs === undefined ? {} : { projectRefs: [...new Set(draft.projectRefs)] }),
    color: draft.color as WorkspaceColor,
    icon: draft.icon,
    image,
  };
}

/** Option can change event.key to a symbol; both number rows use physical codes. */
export function workspaceShortcutIndex(event: {
  readonly code: string;
  readonly key: string;
  readonly metaKey: boolean;
  readonly shiftKey: boolean;
  readonly altKey: boolean;
  readonly ctrlKey: boolean;
}): number | null {
  if (!event.metaKey || !event.altKey || event.shiftKey || event.ctrlKey) return null;
  const digit =
    /^(?:Digit|Numpad)([1-9])$/.exec(event.code)?.[1] ??
    (event.code === "" && /^[1-9]$/.test(event.key) ? event.key : null);
  return digit === null ? null : Number(digit) - 1;
}

export function reorderWorkspaces<T extends { readonly id: string }>(
  workspaces: readonly T[],
  movedId: string,
  targetId: string,
): readonly T[] {
  const from = workspaces.findIndex((workspace) => workspace.id === movedId);
  const to = workspaces.findIndex((workspace) => workspace.id === targetId);
  if (from < 0 || to < 0 || from === to) return workspaces;
  const next = [...workspaces];
  next.splice(to, 0, ...next.splice(from, 1));
  return next;
}
