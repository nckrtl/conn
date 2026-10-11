import type { EnvironmentId } from "@t3tools/contracts";

export interface HomeListFilterMenuEnvironment {
  readonly environmentId: EnvironmentId;
  readonly label: string;
}

/** A workspace from the device's Orbit profile; selecting one scopes the list to its projects. */
export interface HomeListFilterMenuWorkspace {
  readonly id: string;
  readonly label: string;
}

export interface HomeListFilterMenuProject {
  readonly key: string;
  readonly label: string;
  /** The machine(s) the project sits on, set while the list spans several. */
  readonly subtitle?: string;
}

type HomeListFilterMenuAction = {
  readonly type: "action";
  readonly title: string;
  readonly subtitle?: string;
  readonly state?: "on" | "off";
  readonly onPress: () => void;
};

type HomeListFilterMenuSubmenu = {
  readonly type: "submenu";
  readonly title: string;
  readonly items: HomeListFilterMenuAction[];
};

export interface HomeListFilterMenu {
  readonly title: string;
  readonly items: Array<HomeListFilterMenuAction | HomeListFilterMenuSubmenu>;
}

export function buildHomeListFilterMenu(props: {
  readonly environments: ReadonlyArray<HomeListFilterMenuEnvironment>;
  readonly projects: ReadonlyArray<HomeListFilterMenuProject>;
  readonly selectedEnvironmentId: EnvironmentId | null;
  readonly selectedProjectKey: string | null;
  readonly onEnvironmentChange: (environmentId: EnvironmentId | null) => void;
  readonly onProjectChange: (projectKey: string | null) => void;
  readonly workspaces?: ReadonlyArray<HomeListFilterMenuWorkspace>;
  readonly selectedWorkspaceId?: string | null;
  readonly onWorkspaceChange?: (workspaceId: string | null) => void;
}): HomeListFilterMenu {
  const items: Array<HomeListFilterMenuAction | HomeListFilterMenuSubmenu> = [];
  const workspaces = props.workspaces ?? [];
  const onWorkspaceChange = props.onWorkspaceChange;

  if (workspaces.length > 0 && onWorkspaceChange) {
    items.push({
      type: "submenu",
      title: "Workspace",
      items: [
        {
          type: "action",
          title: "All projects",
          subtitle: "Show threads from every workspace",
          state: (props.selectedWorkspaceId ?? null) === null ? "on" : "off",
          onPress: () => onWorkspaceChange(null),
        },
        ...workspaces.map((workspace) => ({
          type: "action" as const,
          title: workspace.label,
          state: props.selectedWorkspaceId === workspace.id ? ("on" as const) : ("off" as const),
          onPress: () => onWorkspaceChange(workspace.id),
        })),
      ],
    });
  }

  items.push({
    type: "submenu",
    title: "Environment",
    items: [
      {
        type: "action",
        title: "All environments",
        subtitle: "Show threads from every environment",
        state: props.selectedEnvironmentId === null ? "on" : "off",
        onPress: () => props.onEnvironmentChange(null),
      },
      ...props.environments.map((environment) => ({
        type: "action" as const,
        title: environment.label,
        state:
          props.selectedEnvironmentId === environment.environmentId
            ? ("on" as const)
            : ("off" as const),
        onPress: () => props.onEnvironmentChange(environment.environmentId),
      })),
    ],
  });

  if (props.projects.length > 0) {
    items.push({
      type: "submenu",
      title: "Project",
      items: [
        {
          type: "action",
          title: "All projects",
          subtitle: "Show threads from every project",
          state: props.selectedProjectKey === null ? "on" : "off",
          onPress: () => props.onProjectChange(null),
        },
        ...props.projects.map((project) => ({
          type: "action" as const,
          title: project.label,
          subtitle: project.subtitle,
          state: props.selectedProjectKey === project.key ? ("on" as const) : ("off" as const),
          onPress: () => props.onProjectChange(project.key),
        })),
      ],
    });
  }

  return {
    title: "Thread list options",
    items,
  };
}
