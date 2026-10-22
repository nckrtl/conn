import { selectOrbitWorkspace, useOrbitGateway } from "../orbit/orbitGatewayStore";
import { WorkspacePhoneBar } from "../workspace/WorkspacePhoneBar";
import { useWorkspacePhoneBar } from "../workspace/useWorkspacePhoneBar";
import { buildHomeListFilterMenu } from "./home-list-filter-menu";
import type { HomeHeaderProps } from "./HomeHeader.types";

export type { HomeHeaderEnvironment } from "./HomeHeader.types";

/**
 * The iOS thread list lives in the workspace, whose WorkspaceToolbar owns its header and search.
 * Conn: on iPhone the thread filters, including the Orbit workspace filter, sit inside the
 * bottom bar's search field (WorkspacePhoneBar).
 */
export function HomeHeader(props: HomeHeaderProps) {
  const gateway = useOrbitGateway();
  const connPhoneBar = useWorkspacePhoneBar();
  if (!connPhoneBar) return null;
  const hasCustomListOptions =
    props.selectedEnvironmentId !== null ||
    props.selectedProjectKey !== null ||
    gateway.selectedWorkspaceId !== null;
  const filterMenu = buildHomeListFilterMenu({
    ...props,
    workspaces: gateway.workspaces.map((workspace) => ({
      id: workspace.id,
      label: workspace.name,
    })),
    selectedWorkspaceId: gateway.selectedWorkspaceId,
    onWorkspaceChange: selectOrbitWorkspace,
  });
  return <WorkspacePhoneBar filterMenu={filterMenu} filterActive={hasCustomListOptions} />;
}
