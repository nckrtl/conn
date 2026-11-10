import { gatewayText, type OrbitGatewayWorkspace } from "./client.ts";

/**
 * Three-way merge of profile workspaces after `conn.settings_version_conflict`. Per id, an
 * unchanged side takes the other's version; when both changed, local wins and an edit beats a
 * deletion. Order follows remote unless only this device reordered; new ones keep their position.
 */
export function mergeWorkspaces(
  base: readonly OrbitGatewayWorkspace[],
  local: readonly OrbitGatewayWorkspace[],
  remote: readonly OrbitGatewayWorkspace[],
): OrbitGatewayWorkspace[] {
  const baseById = byId(base);
  const localById = byId(local);
  const remoteById = byId(remote);

  const resolved = new Map<string, OrbitGatewayWorkspace>();
  for (const id of new Set([...baseById.keys(), ...localById.keys(), ...remoteById.keys()])) {
    const before = baseById.get(id);
    const mine = localById.get(id);
    const theirs = remoteById.get(id);
    const chosen = sameWorkspace(mine, before)
      ? theirs
      : sameWorkspace(theirs, before)
        ? mine
        : (mine ?? theirs);
    if (chosen) resolved.set(id, chosen);
  }

  const localReordered = !sameOrder(base, local);
  const remoteReordered = !sameOrder(base, remote);
  const primary = localReordered && !remoteReordered ? local : remote;
  const secondary = primary === local ? remote : local;

  const ordered: OrbitGatewayWorkspace[] = [];
  const placed = new Set<string>();
  for (const workspace of primary) {
    const chosen = resolved.get(workspace.id);
    if (chosen && !placed.has(chosen.id)) {
      ordered.push(chosen);
      placed.add(chosen.id);
    }
  }
  // Workspaces only the other side has: insert after their nearest preceding neighbour there.
  secondary.forEach((workspace, index) => {
    const chosen = resolved.get(workspace.id);
    if (!chosen || placed.has(chosen.id)) return;
    let at = 0;
    for (let previous = index - 1; previous >= 0; previous -= 1) {
      const neighbour = ordered.findIndex((entry) => entry.id === secondary[previous]!.id);
      if (neighbour !== -1) {
        at = neighbour + 1;
        break;
      }
    }
    ordered.splice(at, 0, chosen);
    placed.add(chosen.id);
  });
  return ordered;
}

/** True when two workspace lists hold the same workspaces with the same content in the same order. */
export function sameWorkspaces(
  left: readonly OrbitGatewayWorkspace[],
  right: readonly OrbitGatewayWorkspace[],
): boolean {
  return (
    left.length === right.length &&
    left.every((workspace, index) => sameWorkspace(workspace, right[index]))
  );
}

function byId(list: readonly OrbitGatewayWorkspace[]): Map<string, OrbitGatewayWorkspace> {
  return new Map(list.map((workspace) => [workspace.id, workspace]));
}

function sameOrder(
  left: readonly OrbitGatewayWorkspace[],
  right: readonly OrbitGatewayWorkspace[],
): boolean {
  const shared = new Set(left.map((workspace) => workspace.id));
  const rightShared = right.filter((workspace) => shared.has(workspace.id)).map((w) => w.id);
  const leftShared = left.map((workspace) => workspace.id).filter((id) => rightShared.includes(id));
  return leftShared.every((id, index) => id === rightShared[index]);
}

function sameWorkspace(
  left: OrbitGatewayWorkspace | undefined,
  right: OrbitGatewayWorkspace | undefined,
): boolean {
  if (left === undefined || right === undefined) return left === right;
  // Compared as the Gateway stores strings (trimmed, empty is null), so what it normalized on
  // the way in does not read as another device's edit.
  return (
    gatewayText(left.id) === gatewayText(right.id) &&
    gatewayText(left.name) === gatewayText(right.name) &&
    gatewayText(left.color) === gatewayText(right.color) &&
    gatewayText(left.icon) === gatewayText(right.icon) &&
    gatewayText(left.image) === gatewayText(right.image) &&
    sameList(left.projectRefs, right.projectRefs) &&
    sameList(left.projectKeys, right.projectKeys)
  );
}

function sameList(
  left: readonly string[] | undefined,
  right: readonly string[] | undefined,
): boolean {
  const a = (left ?? []).flatMap((value) => gatewayText(value) ?? []);
  const b = (right ?? []).flatMap((value) => gatewayText(value) ?? []);
  return a.length === b.length && a.every((value, index) => value === b[index]);
}
