import { createFileRoute } from "@tanstack/react-router";

import { OrbitInstancesPage } from "../components/OrbitInstancesPage";

export const Route = createFileRoute("/_chat/_orbitPanel/orbit/instances")({
  component: OrbitInstancesPage,
});
