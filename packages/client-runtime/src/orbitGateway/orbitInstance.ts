import type { OrbitInstanceDescriptor } from "@t3tools/contracts";

import type { OrbitGatewayEnvironment } from "./client.ts";

/**
 * Conn: the Orbit facts of a clone's server, from its Gateway record. Clones run the stock T3
 * server, which sends no `orbitInstance`, so the Gateway is their source (see FORK.md, "Orbit").
 * Without both ids there is no descriptor; a URL other than http(s) is left out.
 */
export function orbitInstanceFromEnvironment(
  environment: Pick<
    OrbitGatewayEnvironment,
    | "instanceId"
    | "projectId"
    | "projectSlug"
    | "projectName"
    | "instanceName"
    | "nodeName"
    | "instanceUrl"
  >,
): OrbitInstanceDescriptor | undefined {
  const { instanceId, projectId } = environment;
  if (!isPositiveInt(instanceId) || !isPositiveInt(projectId)) return undefined;
  const url = webUrl(environment.instanceUrl);
  return {
    projectId,
    instanceId,
    ...(environment.projectSlug ? { projectSlug: environment.projectSlug } : {}),
    ...(environment.projectName ? { projectName: environment.projectName } : {}),
    ...(environment.instanceName ? { instanceName: environment.instanceName } : {}),
    ...(environment.nodeName ? { nodeName: environment.nodeName } : {}),
    ...(url ? { url } : {}),
  };
}

/** Conn: the descriptors of the Gateway's clone records, by environment id. */
export function orbitInstancesByEnvironment(
  environments: readonly OrbitGatewayEnvironment[],
): Record<string, OrbitInstanceDescriptor> {
  const result: Record<string, OrbitInstanceDescriptor> = {};
  for (const environment of environments) {
    const descriptor = orbitInstanceFromEnvironment(environment);
    if (descriptor) result[environment.environmentId] = descriptor;
  }
  return result;
}

/** Conn: the Gateway's facts first; a fork server's own descriptor only without them. */
export function preferredOrbitInstance(
  gateway: OrbitInstanceDescriptor | undefined,
  server: OrbitInstanceDescriptor | undefined,
): OrbitInstanceDescriptor | undefined {
  return gateway ?? server;
}

function isPositiveInt(value: number | null): value is number {
  return value !== null && Number.isInteger(value) && value >= 1;
}

function webUrl(value: string | null): string | undefined {
  if (!value) return undefined;
  try {
    const { protocol } = new URL(value);
    return protocol === "https:" || protocol === "http:" ? value : undefined;
  } catch {
    return undefined;
  }
}
