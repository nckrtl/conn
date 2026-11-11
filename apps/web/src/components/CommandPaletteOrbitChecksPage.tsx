import { CheckIcon, CircleDashedIcon, RefreshCwIcon, TriangleAlertIcon, XIcon } from "lucide-react";
import { useEffect } from "react";

import {
  checkOrbitProjectAgain,
  forgetOrbitRecheckFailure,
  orbitChecksPageModel,
  useOrbitRecheckPhase,
  type OrbitChecksPageRow,
} from "../orbit/orbitChecksPage";
import { recheckOrbitPaletteProjects } from "../orbit/orbitPaletteProjects";
import {
  ITEM_ICON_CLASS,
  type CommandPaletteActionItem,
  type CommandPaletteGroup,
  type CommandPaletteSubmenuItem,
  type CommandPaletteView,
  type OrbitPaletteProjectRow,
} from "./CommandPalette.logic";

function CheckStatusIcon(props: { readonly status: OrbitChecksPageRow["status"] }) {
  if (props.status === "pass") return <CheckIcon className="size-4 text-success" />;
  if (props.status === "fail") return <XIcon className="size-4 text-destructive" />;
  return <CircleDashedIcon className={ITEM_ICON_CLASS} />;
}

function checkRowDescription(row: OrbitChecksPageRow) {
  if (row.status === "pass") return undefined;
  if (row.status === "not_checked") return "Not checked yet";
  return (
    <span className="whitespace-normal text-muted-foreground">
      {row.message ?? "Orbit did not say what to fix."}
    </span>
  );
}

function CheckAgainTitle(props: { readonly projectId: number }) {
  return useOrbitRecheckPhase(props.projectId) === "checking" ? "Checking…" : "Check again";
}

function CheckAgainNote(props: { readonly projectId: number }) {
  const phase = useOrbitRecheckPhase(props.projectId);
  const { projectId } = props;
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- a "did not answer" note belongs to this visit of the page only
  useEffect(() => () => forgetOrbitRecheckFailure(projectId), [projectId]);
  if (phase === "checking") return "Asking Orbit…";
  if (phase === "failed") {
    return (
      <span className="whitespace-normal text-destructive">
        The Gateway did not answer. The results above are from the last check.
      </span>
    );
  }
  return "Orbit runs the checks again.";
}

/**
 * The checks page of a Project in which threads cannot start yet: the five checks in order, a
 * failing requirement outside them, and "Check again". Once threads can start, it offers the
 * Instance step.
 */
export function orbitChecksPageGroups(input: {
  readonly value: string;
  readonly project: OrbitPaletteProjectRow;
  readonly instancesView: CommandPaletteView;
}): CommandPaletteGroup[] {
  const { value, project } = input;
  const model = orbitChecksPageModel(project);
  const checkItems: CommandPaletteActionItem[] = model.rows.map((row) => {
    const description = checkRowDescription(row);
    return {
      kind: "action",
      value: `${value}:check:${row.key}`,
      searchTerms: [],
      title: row.label,
      ...(description === undefined ? {} : { description }),
      icon: <CheckStatusIcon status={row.status} />,
      disabled: true,
      run: async () => {},
    };
  });
  if (model.reason !== null) {
    checkItems.push({
      kind: "action",
      value: `${value}:reason`,
      searchTerms: [],
      title: <span className="whitespace-normal">{model.reason}</span>,
      icon: <TriangleAlertIcon className={ITEM_ICON_CLASS} />,
      disabled: true,
      run: async () => {},
    });
  }
  const next: CommandPaletteActionItem | CommandPaletteSubmenuItem = model.startable
    ? {
        kind: "submenu",
        value: `${value}:instances`,
        searchTerms: [],
        title: "Choose an Instance",
        description: "Threads can start in this project now.",
        icon: <CheckIcon className="size-4 text-success" />,
        addonIcon: input.instancesView.addonIcon,
        groups: input.instancesView.groups,
      }
    : {
        kind: "action",
        value: `${value}:check-again`,
        searchTerms: [],
        title: <CheckAgainTitle projectId={project.id} />,
        searchTitle: "Check again",
        description: <CheckAgainNote projectId={project.id} />,
        icon: <RefreshCwIcon className={ITEM_ICON_CLASS} />,
        keepOpen: true,
        run: () => checkOrbitProjectAgain(project.id, recheckOrbitPaletteProjects),
      };
  return [
    { value, label: project.name, items: checkItems },
    { value: `${value}:next`, label: "", items: [next] },
  ];
}
