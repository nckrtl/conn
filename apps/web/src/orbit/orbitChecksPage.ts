import type { OrbitGatewayProjectCheck } from "@t3tools/client-runtime/orbit-gateway";
import { create } from "zustand";

import type { OrbitPaletteProjectRow } from "../components/CommandPalette.logic";

/** The five start checks the page always shows, in Orbit's order, with Conn's own text. */
export const ORBIT_START_CHECKS = [
  { key: "default_instance", label: "Default Instance" },
  { key: "container", label: "Runs in a container" },
  { key: "active", label: "Active" },
  { key: "seed_snapshot", label: "Seed snapshot" },
  { key: "node_access", label: "Node access" },
] as const;

const OTHER_REQUIREMENT_LABEL = "Other requirement";

export interface OrbitChecksPageRow {
  readonly key: string;
  readonly label: string;
  readonly status: OrbitGatewayProjectCheck["status"];
  /** Orbit's text on what to fix, only on a failing row. */
  readonly message: string | null;
}

export interface OrbitChecksPageModel {
  readonly rows: ReadonlyArray<OrbitChecksPageRow>;
  /** Shown alone when threads cannot start and no check fails. */
  readonly reason: string | null;
  readonly startable: boolean;
}

/**
 * The checks page of a Project. Checks stop at the first fail, so later ones count as not checked
 * even if a Gateway sent more. A failing check outside the five adds one row with Orbit's label.
 */
export function orbitChecksPageModel(
  project: Pick<OrbitPaletteProjectRow, "startable" | "reason" | "checks">,
): OrbitChecksPageModel {
  const checks = project.checks ?? [];
  const failIndex = checks.findIndex((check) => check.status === "fail");
  const firstFail = checks[failIndex] ?? null;
  const rows: OrbitChecksPageRow[] = ORBIT_START_CHECKS.map(({ key, label }) => {
    const index = checks.findIndex((check) => check.key === key);
    const check = checks[index];
    const status =
      check === undefined || (failIndex !== -1 && index > failIndex) ? "not_checked" : check.status;
    return { key, label, status, message: status === "fail" ? (check?.message ?? null) : null };
  });
  const knownKeys: ReadonlySet<string> = new Set(ORBIT_START_CHECKS.map((check) => check.key));
  if (firstFail !== null && !knownKeys.has(firstFail.key)) {
    rows.push({
      key: firstFail.key,
      label: firstFail.label ?? OTHER_REQUIREMENT_LABEL,
      status: "fail",
      message: firstFail.message,
    });
  }
  return {
    rows,
    reason:
      project.startable || firstFail !== null
        ? null
        : (project.reason ?? "Orbit did not say why threads cannot start here yet."),
    startable: project.startable,
  };
}

export type OrbitRecheckPhase = "idle" | "checking" | "failed";

const useOrbitRecheckStore = create<{
  readonly projectId: number | null;
  readonly phase: OrbitRecheckPhase;
}>(() => ({ projectId: null, phase: "idle" }));

/** "Check again": re-reads the project list; a failed read keeps the last result and says so. */
export async function checkOrbitProjectAgain(
  projectId: number,
  reread: () => Promise<boolean>,
): Promise<void> {
  const current = useOrbitRecheckStore.getState();
  if (current.projectId === projectId && current.phase === "checking") return;
  useOrbitRecheckStore.setState({ projectId, phase: "checking" });
  const answered = await reread().catch(() => false);
  if (useOrbitRecheckStore.getState().projectId !== projectId) return;
  useOrbitRecheckStore.setState({ phase: answered ? "idle" : "failed" });
}

export function useOrbitRecheckPhase(projectId: number): OrbitRecheckPhase {
  return useOrbitRecheckStore((store) => (store.projectId === projectId ? store.phase : "idle"));
}

/** Leaving the page drops an old "did not answer" note; a running check finishes on its own. */
export function forgetOrbitRecheckFailure(projectId: number): void {
  const current = useOrbitRecheckStore.getState();
  if (current.projectId === projectId && current.phase === "failed") {
    useOrbitRecheckStore.setState({ phase: "idle" });
  }
}

export function readOrbitRecheckPhase(projectId: number): OrbitRecheckPhase {
  const current = useOrbitRecheckStore.getState();
  return current.projectId === projectId ? current.phase : "idle";
}
