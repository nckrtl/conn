import {
  ORBIT_SOURCE_HEAD_UNAVAILABLE,
  type OrbitGatewayBranch,
  type OrbitGatewayBranches,
  type OrbitGatewayBranchSelection,
} from "@t3tools/client-runtime/orbit-gateway";

import type { OrbitDraftTarget } from "./orbitDraft";

/**
 * Conn: the gate for branch on create. Until Orbit accepts the `branch` field no
 * build may send it: off, the branch control is hidden, no branches are read and no create
 * carries a branch. Flip to `true` once branch on create is live.
 */
export const ORBIT_BRANCH_CONTROL_ENABLED = false;

export type OrbitBranchMode = OrbitGatewayBranchSelection["mode"];

/** Shown until the branch list was read; Orbit's own name replaces it then. */
const FALLBACK_DEFAULT_BRANCH = "main";
/** The desktop IPC refuses a longer search. */
export const ORBIT_BRANCH_QUERY_MAX_LENGTH = 200;
export const ORBIT_BRANCH_SEARCH_DEBOUNCE_MS = 300;

export const ORBIT_BRANCH_MODE_LABELS: Readonly<Record<OrbitBranchMode, string>> = {
  new: "New branch from",
  existing: "Work on branch",
};

export function orbitDefaultBranchName(target: Pick<OrbitDraftTarget, "defaultBranch">): string {
  return target.defaultBranch ?? FALLBACK_DEFAULT_BRANCH;
}

/** The control's label: "From main" by default, "From develop", or "On feature/login". */
export function orbitBranchControlLabel(
  target: Pick<OrbitDraftTarget, "branch" | "defaultBranch">,
): string {
  const branch = target.branch ?? null;
  if (branch === null) return `From ${orbitDefaultBranchName(target)}`;
  return branch.mode === "new" ? `From ${branch.from}` : `On ${branch.name}`;
}

/** The mode the menu opens in: the draft's own, else "New branch from". */
export function orbitBranchMenuMode(target: Pick<OrbitDraftTarget, "branch">): OrbitBranchMode {
  return target.branch?.mode ?? "new";
}

export type OrbitBranchRowAction =
  | { readonly kind: "branch"; readonly selection: OrbitGatewayBranchSelection | null }
  /** The branch is another Instance's: picking it selects that Instance. */
  | { readonly kind: "instance"; readonly instance: { readonly id: number; readonly name: string } }
  | { readonly kind: "disabled" };

export interface OrbitBranchRow {
  readonly name: string;
  readonly isDefault: boolean;
  /** `PR #482`, or null without a PR or when Orbit has no PR data for the repository. */
  readonly pullRequestLabel: string | null;
  /** "default", "in instance login", or why the row cannot be picked. */
  readonly note: string | null;
  readonly selected: boolean;
  readonly action: OrbitBranchRowAction;
}

export const ORBIT_DEFAULT_BRANCH_IN_USE_NOTE = "default · the default Instance works on it";

/**
 * The menu's rows for a mode. "New branch from": every branch is a base; the default one means no
 * choice ("From main"), so the create sends no branch. "Work on branch": the default branch is
 * disabled (Orbit would answer branch.in_use with the default Instance), and a branch another
 * Instance works on picks that Instance, so two Instances never work on one branch.
 */
export function orbitBranchMenuRows(input: {
  readonly list: OrbitGatewayBranches;
  readonly mode: OrbitBranchMode;
  readonly current: OrbitGatewayBranchSelection | null;
}): OrbitBranchRow[] {
  const { list, mode, current } = input;
  return list.branches.map((branch): OrbitBranchRow => {
    const pullRequestLabel =
      list.pullRequestsUnavailable || branch.pullRequest === null
        ? null
        : `PR #${branch.pullRequest.number}`;
    if (mode === "new") {
      return {
        name: branch.name,
        isDefault: branch.default,
        pullRequestLabel,
        note: branch.default ? "default" : null,
        selected:
          current === null
            ? branch.default
            : current.mode === "new" && current.from === branch.name,
        action: {
          kind: "branch",
          selection: branch.default ? null : { mode: "new", from: branch.name },
        },
      };
    }
    if (branch.default) {
      return {
        name: branch.name,
        isDefault: true,
        pullRequestLabel,
        note: ORBIT_DEFAULT_BRANCH_IN_USE_NOTE,
        selected: false,
        action: { kind: "disabled" },
      };
    }
    if (branch.instance !== null) {
      return {
        name: branch.name,
        isDefault: false,
        pullRequestLabel,
        note: `in instance ${branch.instance.name}`,
        selected: false,
        action: { kind: "instance", instance: branch.instance },
      };
    }
    return {
      name: branch.name,
      isDefault: false,
      pullRequestLabel,
      note: null,
      selected: current?.mode === "existing" && current.name === branch.name,
      action: { kind: "branch", selection: { mode: "existing", name: branch.name } },
    };
  });
}

/** The default branch the list names, or null when it lists none (a search can leave it out). */
export function orbitListedDefaultBranch(branches: readonly OrbitGatewayBranch[]): string | null {
  return branches.find((branch) => branch.default)?.name ?? null;
}

/** The search as sent: trimmed and cut to what the desktop IPC lets through. */
export function orbitBranchQuery(text: string): string {
  return text.trim().slice(0, ORBIT_BRANCH_QUERY_MAX_LENGTH);
}

export type OrbitBranchListState =
  | { readonly status: "loading" }
  | { readonly status: "loaded"; readonly list: OrbitGatewayBranches }
  | { readonly status: "failed"; readonly message: string; readonly retry: boolean };

export const ORBIT_BRANCHES_READ_FAILED = "Could not read the repository.";
export const ORBIT_BRANCHES_NO_MATCH = "No branch matches this search.";
export const ORBIT_BRANCHES_EMPTY = "No branches found.";
export const ORBIT_BRANCHES_LOADING = "Reading branches…";
export const ORBIT_BRANCHES_DEFAULT_MISSING =
  "Orbit cannot create Instances in this Project now: its default Instance is not ready.";

/**
 * What a failed read shows. An invalid ref name in a search also answers 502
 * `source.head_unavailable`, so with a search it reads as "no match", never as an outage.
 */
export function orbitBranchListFailure(
  error: unknown,
  query: string,
): Extract<OrbitBranchListState, { status: "failed" }> {
  const code =
    typeof error === "object" && error !== null && "code" in error
      ? (error as { code: unknown }).code
      : null;
  if (code === "instance.default_missing") {
    return { status: "failed", message: ORBIT_BRANCHES_DEFAULT_MISSING, retry: false };
  }
  if (code === ORBIT_SOURCE_HEAD_UNAVAILABLE && query !== "") {
    return { status: "failed", message: ORBIT_BRANCHES_NO_MATCH, retry: true };
  }
  return { status: "failed", message: ORBIT_BRANCHES_READ_FAILED, retry: true };
}

/** The status line under the search, or null when rows show. */
export function orbitBranchListStatus(state: OrbitBranchListState, query: string): string | null {
  if (state.status === "loading") return ORBIT_BRANCHES_LOADING;
  if (state.status === "failed") return state.message;
  if (state.list.branches.length > 0) return null;
  return query === "" ? ORBIT_BRANCHES_EMPTY : ORBIT_BRANCHES_NO_MATCH;
}

/**
 * The menu asks Change branch to open it once the reopened draft shows. Keyed by Orbit Project,
 * since the draft is one per Project.
 */
const pendingMenuOpen = new Set<number>();

export function requestOrbitBranchMenu(projectId: number): void {
  pendingMenuOpen.add(projectId);
}

export function takeOrbitBranchMenuRequest(projectId: number): boolean {
  return pendingMenuOpen.delete(projectId);
}

/**
 * The menu's search: each keystroke waits `ORBIT_BRANCH_SEARCH_DEBOUNCE_MS` before it reads, and
 * only the latest read's answer counts. A read can take 25 s, so the list shows loading that long.
 */
export function createOrbitBranchSearch(input: {
  readonly read: (query: string) => Promise<OrbitGatewayBranches>;
  readonly onState: (state: OrbitBranchListState, query: string) => void;
  /** The default branch, whenever an answer names it. */
  readonly onDefaultBranch?: (name: string) => void;
}) {
  let generation = 0;
  let timer: ReturnType<typeof setTimeout> | null = null;
  const cancelTimer = () => {
    if (timer !== null) clearTimeout(timer);
    timer = null;
  };
  const run = (query: string) => {
    cancelTimer();
    const current = ++generation;
    input.onState({ status: "loading" }, query);
    input.read(query).then(
      (list) => {
        if (current !== generation) return;
        input.onState({ status: "loaded", list }, query);
        const defaultBranch = orbitListedDefaultBranch(list.branches);
        if (defaultBranch !== null) input.onDefaultBranch?.(defaultBranch);
      },
      (error: unknown) => {
        if (current === generation) input.onState(orbitBranchListFailure(error, query), query);
      },
    );
  };
  return {
    /** A keystroke: reads after the pause. */
    search: (text: string) => {
      cancelTimer();
      const query = orbitBranchQuery(text);
      timer = setTimeout(() => run(query), ORBIT_BRANCH_SEARCH_DEBOUNCE_MS);
    },
    /** Opening the menu or Retry: reads at once. */
    readNow: (text: string) => run(orbitBranchQuery(text)),
    /** Closing the menu: a late answer is dropped. */
    dispose: () => {
      cancelTimer();
      generation++;
    },
  };
}
