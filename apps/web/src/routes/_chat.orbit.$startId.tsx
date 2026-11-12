import { createFileRoute } from "@tanstack/react-router";

import { OrbitPendingThreadView } from "../orbit/OrbitPendingThreadView";

function OrbitPendingThreadRoute() {
  const { startId } = Route.useParams();
  return <OrbitPendingThreadView startId={startId} />;
}

export const Route = createFileRoute("/_chat/orbit/$startId")({
  component: OrbitPendingThreadRoute,
});
