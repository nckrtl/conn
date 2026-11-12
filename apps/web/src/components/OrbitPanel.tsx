import { useLocation, useNavigate } from "@tanstack/react-router";
import { PlugIcon, UserRoundIcon } from "lucide-react";
import { useEffect, type ComponentType, type ReactNode } from "react";

import { workspaceAreaProps } from "../lib/workspaceFocus";
import { cn } from "../lib/utils";
import { useOrbitThreadsAvailable } from "../orbit/environmentProvider";
import { ORBIT_PANEL_PAGES, type OrbitPanelPath } from "../orbit/orbitPanelPages";
import {
  APP_ROUTE_MODAL_NAV_CLASS,
  AppRouteModal,
  AppRouteModalCard,
  AppRouteModalClose,
  AppRouteModalHeader,
} from "./AppRouteModal";
import { handleSettingsSectionKeyDown } from "./settings/settingsSectionNavigation";
import { useCloseAppModal } from "./sidebar/mainAppLocation";
import {
  SidebarContent,
  SidebarGroup,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
} from "./ui/sidebar";
import {
  WorkspaceBreadcrumb,
  WorkspaceBreadcrumbItem,
  WorkspaceBreadcrumbSeparator,
} from "./WorkspaceBreadcrumb";

const PAGE_ICONS: Record<OrbitPanelPath, ComponentType<{ className?: string }>> = {
  "/orbit/connection": PlugIcon,
  "/orbit/profile": UserRoundIcon,
};

function OrbitPanelNav({ pathname }: { pathname: string }) {
  const navigate = useNavigate();
  return (
    <nav
      {...workspaceAreaProps("orbit-nav", 0, "Orbit sections")}
      role="navigation"
      className={cn(
        "flex w-60 shrink-0 flex-col text-sidebar-foreground max-md:w-14",
        APP_ROUTE_MODAL_NAV_CLASS,
      )}
    >
      <SidebarContent className="overflow-x-hidden">
        <SidebarGroup>
          <div onKeyDown={handleSettingsSectionKeyDown}>
            <SidebarMenu>
              {ORBIT_PANEL_PAGES.map(({ path, label }) => {
                const Icon = PAGE_ICONS[path];
                const isActive = pathname === path;
                return (
                  <SidebarMenuItem key={path}>
                    <SidebarMenuButton
                      data-settings-section={path}
                      aria-current={isActive ? "page" : undefined}
                      isActive={isActive}
                      onClick={() => void navigate({ to: path, hash: "", replace: true })}
                    >
                      <Icon />
                      <span className="truncate max-md:sr-only">{label}</span>
                    </SidebarMenuButton>
                  </SidebarMenuItem>
                );
              })}
            </SidebarMenu>
          </div>
        </SidebarGroup>
      </SidebarContent>
    </nav>
  );
}

/** Leaves the panel once Orbit is off: its pages read the Gateway, which Default mode never uses. */
function CloseOrbitPanel() {
  const closeAppModal = useCloseAppModal();
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- the router leaves the panel when the environment provider (a store outside the route) stops being Orbit
  useEffect(() => {
    void closeAppModal();
  }, [closeAppModal]);
  return null;
}

/**
 * Conn: the Orbit panel, Orbit's configuration in the same shell as Settings (FORK.md, "Orbit
 * panel"). It exists only in the desktop app with "Environments from" set to Orbit.
 */
export function OrbitPanelLayout({ children }: { children: ReactNode }) {
  const pathname = useLocation({ select: (location) => location.pathname });
  const available = useOrbitThreadsAvailable();
  if (!available) return <CloseOrbitPanel />;
  const page = ORBIT_PANEL_PAGES.find((entry) => entry.path === pathname);

  return (
    <AppRouteModal label="Orbit">
      <AppRouteModalHeader>
        <WorkspaceBreadcrumb ariaLabel="Orbit breadcrumb">
          <WorkspaceBreadcrumbItem>Orbit</WorkspaceBreadcrumbItem>
          <WorkspaceBreadcrumbSeparator />
          <WorkspaceBreadcrumbItem current className="truncate">
            {page?.label ?? "Orbit"}
          </WorkspaceBreadcrumbItem>
        </WorkspaceBreadcrumb>
        <div className="ms-auto flex shrink-0 items-center gap-1">
          <AppRouteModalClose />
        </div>
      </AppRouteModalHeader>
      <div className="relative flex min-h-0 flex-1">
        <OrbitPanelNav pathname={pathname} />
        <AppRouteModalCard besideNav {...workspaceAreaProps("orbit", 1, "Orbit content")}>
          <div className="min-h-0 flex flex-1 flex-col">{children}</div>
        </AppRouteModalCard>
      </div>
    </AppRouteModal>
  );
}
