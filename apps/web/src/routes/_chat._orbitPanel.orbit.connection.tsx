import { createFileRoute } from "@tanstack/react-router";

import { OrbitConnectionPage } from "../components/settings/OrbitSettings";

export const Route = createFileRoute("/_chat/_orbitPanel/orbit/connection")({
  component: OrbitConnectionPage,
});
