import type { MenuAction } from "@react-native-menu/menu";
import { useCallback, useMemo } from "react";
import { NativeStackScreenOptions } from "../../native/StackHeader";
import { ThreadListToolbar } from "./ThreadListToolbar";
import type { HomeHeaderProps } from "./HomeHeader.types";
import { selectOrbitWorkspace, useOrbitGateway } from "../orbit/orbitGatewayStore";

export type { HomeHeaderEnvironment } from "./HomeHeader.types";

function checkedMenuState(checked: boolean) {
  return checked ? ("on" as const) : undefined;
}

export function HomeHeader(props: HomeHeaderProps) {
  // The list uses a fixed creation order and ignores sort/group options, so
  // the filter menu only carries the filters and the "customized" icon state
  // keys off those alone.
  const gateway = useOrbitGateway();
  const hasCustomListOptions =
    props.selectedEnvironmentId !== null ||
    props.selectedProjectKey !== null ||
    gateway.selectedWorkspaceId !== null;
  const menuActions = useMemo<MenuAction[]>(
    () => [
      ...(gateway.workspaces.length === 0
        ? []
        : ([
            {
              id: "workspace",
              title: "Workspace",
              subactions: [
                {
                  id: "workspace:all",
                  title: "All projects",
                  state: checkedMenuState(gateway.selectedWorkspaceId === null),
                },
                ...gateway.workspaces.map((workspace) => ({
                  id: `workspace:${workspace.id}`,
                  title: workspace.name,
                  state: checkedMenuState(gateway.selectedWorkspaceId === workspace.id),
                })),
              ],
            },
          ] satisfies MenuAction[])),
      {
        id: "environment",
        title: "Environment",
        subactions: [
          {
            id: "environment:all",
            title: "All environments",
            state: checkedMenuState(props.selectedEnvironmentId === null),
          },
          ...props.environments.map((environment) => ({
            id: `environment:${environment.environmentId}`,
            title: environment.label,
            state: checkedMenuState(props.selectedEnvironmentId === environment.environmentId),
          })),
        ],
      },
      ...(props.projects.length === 0
        ? []
        : ([
            {
              id: "project",
              title: "Project",
              subactions: [
                {
                  id: "project:all",
                  title: "All projects",
                  state: checkedMenuState(props.selectedProjectKey === null),
                },
                ...props.projects.map((project) => ({
                  id: `project:${project.key}`,
                  // Android menus have no subtitle line.
                  title: project.subtitle
                    ? `${project.label} · ${project.subtitle}`
                    : project.label,
                  state: checkedMenuState(props.selectedProjectKey === project.key),
                })),
              ],
            },
          ] satisfies MenuAction[])),
    ],
    [
      gateway.selectedWorkspaceId,
      gateway.workspaces,
      props.environments,
      props.projects,
      props.selectedEnvironmentId,
      props.selectedProjectKey,
    ],
  );
  const handleMenuAction = useCallback(
    (event: { nativeEvent: { event: string } }) => {
      const id = event.nativeEvent.event;
      if (id === "workspace:all") {
        selectOrbitWorkspace(null);
        return;
      }

      if (id.startsWith("workspace:")) {
        selectOrbitWorkspace(id.slice("workspace:".length));
        return;
      }

      if (id === "environment:all") {
        props.onEnvironmentChange(null);
        return;
      }

      if (id.startsWith("environment:")) {
        const environmentId = id.slice("environment:".length);
        const environment = props.environments.find(
          (candidate) => candidate.environmentId === environmentId,
        );
        if (environment) {
          props.onEnvironmentChange(environment.environmentId);
        }
        return;
      }

      if (id === "project:all") {
        props.onProjectChange(null);
        return;
      }

      if (id.startsWith("project:")) {
        const projectKey = id.slice("project:".length);
        if (props.projects.some((project) => project.key === projectKey)) {
          props.onProjectChange(projectKey);
        }
        return;
      }
    },
    [props],
  );

  return (
    <>
      <NativeStackScreenOptions options={{ headerShown: false }} />
      <ThreadListToolbar
        searchQuery={props.searchQuery}
        onSearchQueryChange={props.onSearchQueryChange}
        filterActions={menuActions}
        filterCustomized={hasCustomListOptions}
        onFilterAction={handleMenuAction}
        onOpenSettings={props.onOpenSettings}
        onOpenEnvironments={props.onOpenEnvironments}
      />
    </>
  );
}
