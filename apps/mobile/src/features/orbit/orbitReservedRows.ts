import {
  isReservedOrbitEnvironment,
  type OrbitGatewayEnvironment,
} from "@t3tools/client-runtime/orbit-gateway";

/** Conn: the servers of reserved clones in the Gateway's last list, which no list shows. */
let listed: readonly string[] = [];
const listeners = new Set<() => void>();

export function noteOrbitReservedEnvironments(
  environments: readonly OrbitGatewayEnvironment[] | null,
): void {
  const next = (environments ?? [])
    .filter(isReservedOrbitEnvironment)
    .map((row) => row.environmentId);
  if (next.length === listed.length && next.every((id, index) => id === listed[index])) return;
  listed = next;
  for (const listener of listeners) listener();
}

export function listedOrbitReservedEnvironments(): readonly string[] {
  return listed;
}

export function subscribeOrbitReservedEnvironments(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}
