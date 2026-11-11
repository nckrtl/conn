import { deriveProjectIdentity } from "@t3tools/shared/projectIdentity";
import { ChevronRightIcon, TriangleAlertIcon } from "lucide-react";
import type { ReactNode } from "react";

import {
  ADDON_ICON_CLASS,
  ITEM_ICON_CLASS,
  orbitPaletteProjectSubline,
  type CommandPaletteActionItem,
  type CommandPaletteGroup,
  type CommandPaletteView,
  type OrbitPaletteProjectRow,
  type OrbitPaletteProjectsState,
} from "./CommandPalette.logic";
import { OrbitLogoIcon } from "./OrbitLogoIcon";
import { ProjectMonogram } from "./ProjectMonogram";
import { COMMAND_PALETTE_META_ICON_CLASS } from "./ThreadCommandSubtitle";
import { Skeleton } from "./ui/skeleton";

const ORBIT_PAGE_PREFIX = "orbit-page";

/**
 * The palette pages an Orbit Project row opens. The Instance step lives in
 * `CommandPaletteOrbitInstanceStep.tsx`; the resolver below maps the other kinds to their
 * component (PR 2c replaces the `checks` placeholder).
 */
export type OrbitPalettePageKind = "instances" | "checks";

export interface OrbitPalettePage {
  readonly kind: OrbitPalettePageKind;
  readonly projectId: number;
}

function OrbitChecksPagePlaceholder(_props: { readonly project: OrbitPaletteProjectRow }) {
  return <span className="whitespace-normal">Placeholder: the start checks come in PR 2c.</span>;
}

const ORBIT_PALETTE_PAGES = {
  checks: OrbitChecksPagePlaceholder,
} satisfies Record<
  Exclude<OrbitPalettePageKind, "instances">,
  (props: { readonly project: OrbitPaletteProjectRow }) => ReactNode
>;

function orbitPalettePageValue(page: OrbitPalettePage): string {
  return `${ORBIT_PAGE_PREFIX}:${page.kind}:${page.projectId}`;
}

/** The Orbit page a palette view shows, from its first group's value; null for other views. */
export function parseOrbitPalettePage(value: string | undefined): OrbitPalettePage | null {
  const [prefix, kind, id] = value?.split(":") ?? [];
  if (prefix !== ORBIT_PAGE_PREFIX || (kind !== "instances" && kind !== "checks")) return null;
  const projectId = Number(id);
  return Number.isInteger(projectId) ? { kind, projectId } : null;
}

/** The palette view of an Orbit page; its groups resolve while rendering. */
export function orbitPalettePageView(page: OrbitPalettePage): CommandPaletteView {
  return {
    addonIcon: <OrbitLogoIcon className={ADDON_ICON_CLASS} />,
    groups: [{ value: orbitPalettePageValue(page), label: "", items: [] }],
  };
}

/** The live groups of the checks page, or of any Orbit page once its Project left the list. */
export function orbitPalettePageGroups(
  page: OrbitPalettePage,
  project: OrbitPaletteProjectRow | null,
): CommandPaletteGroup[] {
  const value = orbitPalettePageValue(page);
  if (project === null) {
    return [
      {
        value,
        label: "",
        items: [
          {
            kind: "action",
            value: `${value}:gone`,
            searchTerms: [],
            title: "This Orbit project is no longer listed.",
            icon: null,
            disabled: true,
            run: async () => {},
          },
        ],
      },
    ];
  }
  const Page = ORBIT_PALETTE_PAGES.checks;
  return [
    {
      value,
      label: project.name,
      items: [
        {
          kind: "action",
          value: `${value}:body`,
          searchTerms: [],
          title: <Page project={project} />,
          icon: null,
          disabled: true,
          run: async () => {},
        },
      ],
    },
  ];
}

function OrbitProjectDescription(props: { readonly row: OrbitPaletteProjectRow }) {
  return (
    <span className="flex min-w-0 items-center gap-1">
      <OrbitLogoIcon className={COMMAND_PALETTE_META_ICON_CLASS} />
      <span className="min-w-0 flex-1 truncate">{orbitPaletteProjectSubline(props.row)}</span>
    </span>
  );
}

function OrbitProjectTrailing(props: { readonly startable: boolean }) {
  return (
    <span className="ms-auto flex shrink-0 items-center gap-0.5 text-muted-foreground/70 text-xs">
      {props.startable ? null : "Why?"}
      <ChevronRightIcon className="-me-0.5 size-4" />
    </span>
  );
}

/** Orbit Projects as rows of the New thread list, in the same badge style as local projects. */
export function buildOrbitProjectItems(input: {
  readonly rows: ReadonlyArray<OrbitPaletteProjectRow>;
  readonly openPage: (view: CommandPaletteView, row: OrbitPaletteProjectRow) => void;
}): CommandPaletteActionItem[] {
  return input.rows.map((row) => {
    const identity = deriveProjectIdentity(row.name);
    const page: OrbitPalettePage = {
      kind: row.startable ? "instances" : "checks",
      projectId: row.id,
    };
    return {
      kind: "action",
      value: `orbit-project:${row.id}`,
      searchTerms: [row.name, row.slug, "orbit"],
      title: row.name,
      description: <OrbitProjectDescription row={row} />,
      icon: (
        <ProjectMonogram
          text={identity.monogram}
          color={identity.color}
          className={ITEM_ICON_CLASS}
        />
      ),
      titleTrailingContent: <OrbitProjectTrailing startable={row.startable} />,
      ...(row.startable ? {} : { dimmed: true }),
      keepOpen: true,
      run: async () => input.openPage(orbitPalettePageView(page), row),
    };
  });
}

const SKELETON_TITLE_WIDTHS = ["46%", "37%", "28%"];

function OrbitProjectSkeletonTitle(props: { readonly width: string }) {
  return (
    <span className="flex w-60 flex-col gap-1.5 py-0.5">
      <Skeleton className="h-3" style={{ width: props.width }} />
      <Skeleton className="h-2.5 w-1/2" />
    </span>
  );
}

/** What the list shows below the local projects while Orbit's list loads or after it failed. */
export function orbitProjectsStateGroups(input: {
  readonly state: OrbitPaletteProjectsState;
  readonly retry: () => void;
}): CommandPaletteGroup[] {
  if (input.state.status === "loading") {
    return [
      {
        value: "orbit-projects-loading",
        label: "Loading Orbit projects…",
        items: SKELETON_TITLE_WIDTHS.map((width, index) => ({
          kind: "action",
          value: `orbit-projects-loading:${index}`,
          searchTerms: [],
          title: <OrbitProjectSkeletonTitle width={width} />,
          icon: <Skeleton className="size-4" />,
          disabled: true,
          run: async () => {},
        })),
      },
    ];
  }
  if (input.state.status === "unreachable") {
    return [
      {
        value: "orbit-projects-unreachable",
        label: "",
        items: [
          {
            kind: "action",
            value: "orbit-projects:retry",
            searchTerms: [],
            title: (
              <span className="whitespace-normal text-muted-foreground">
                Orbit projects are not shown: the Gateway did not answer. Your other projects work
                as usual.
              </span>
            ),
            searchTitle: "Orbit projects are not shown",
            icon: <TriangleAlertIcon className={ITEM_ICON_CLASS} />,
            titleTrailingContent: (
              <span className="ms-auto shrink-0 rounded-sm border border-border px-1.5 py-0.5 text-foreground text-xs">
                Retry
              </span>
            ),
            keepOpen: true,
            run: async () => input.retry(),
          },
        ],
      },
    ];
  }
  return [];
}
