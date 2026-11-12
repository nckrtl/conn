import { Outlet, createFileRoute } from "@tanstack/react-router";

import { OrbitPanelLayout } from "../components/OrbitPanel";

function OrbitPanelRoute() {
  return (
    <OrbitPanelLayout>
      <Outlet />
    </OrbitPanelLayout>
  );
}

export const Route = createFileRoute("/_chat/_orbitPanel")({
  component: OrbitPanelRoute,
});
