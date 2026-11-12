import { createFileRoute } from "@tanstack/react-router";

import { OrbitProfilePage } from "../components/OrbitProfilePage";

export const Route = createFileRoute("/_chat/_orbitPanel/orbit/profile")({
  component: OrbitProfilePage,
});
