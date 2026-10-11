import type { EnvironmentId } from "@t3tools/contracts";

/** Looks up the name a machine goes by (its saved environment label), or null when unknown. */
export type EnvironmentLabelLookup = (environmentId: EnvironmentId) => string | null;

/** Distinct machine names for a set of projects, in first-seen order. */
export function projectMachineNames(
  projects: ReadonlyArray<{ readonly environmentId: EnvironmentId }>,
  labelFor: EnvironmentLabelLookup,
): ReadonlyArray<string> {
  const names: string[] = [];
  for (const project of projects) {
    const name = labelFor(project.environmentId);
    if (name && !names.includes(name)) names.push(name);
  }
  return names;
}

/**
 * One line for the machines behind a project row: the name itself, two names
 * joined, or a count once the list would no longer fit a compact subtitle.
 */
export function summarizeMachineNames(names: ReadonlyArray<string>): string | null {
  if (names.length === 0) return null;
  if (names.length <= 2) return names.join(", ");
  return `${names.length} machines`;
}

/**
 * The machine line for a project row, or null when it adds nothing. Callers
 * pass `labelFor` that returns null for every environment while the user has a
 * single machine, so single-machine setups keep their current rows.
 */
export function projectMachineLabel(
  projects: ReadonlyArray<{ readonly environmentId: EnvironmentId }>,
  labelFor: EnvironmentLabelLookup,
): string | null {
  return summarizeMachineNames(projectMachineNames(projects, labelFor));
}

/** Joins the machine with the row's own detail (path, workspace count) for plain-text subtitles. */
export function joinMachineAndDetail(machine: string | null, detail: string): string {
  return machine ? `${machine} · ${detail}` : detail;
}
