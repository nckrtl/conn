import { createFileRoute } from "@tanstack/react-router";

import { OrbitProfilePage } from "../components/settings/OrbitSettings";

export const Route = createFileRoute("/_chat/_orbitPanel/orbit/profile")({
  component: OrbitProfilePage,
});
