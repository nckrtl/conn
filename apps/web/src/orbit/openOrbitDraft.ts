import { scopeProjectRef } from "@t3tools/client-runtime/environment";
import type { AnyRouter } from "@tanstack/react-router";

import { useComposerDraftStore, type DraftId } from "../composerDraftStore";
import { environmentCatalog } from "../connection/catalog";
import { getClientSettings } from "../hooks/useSettings";
import { newDraftId, newThreadId } from "../lib/utils";
import { appAtomRegistry } from "../rpc/atomRegistry";
import { primaryEnvironmentIdAtom } from "../state/primaryEnvironment";
import { useEnvironmentProvider } from "./environmentProvider";
import {
  chooseOrbitDraftAnchor,
  orbitDraftLogicalProjectKey,
  orbitDraftProjectId,
  type OrbitDraftTarget,
} from "./orbitDraft";

/**
 * Opens the composer draft for a thread in an Orbit Instance: a new Instance, or an existing one
 * this device has not paired yet. A paired, running Instance needs no Orbit draft; open a normal
 * draft in its `/srv/workspace` project instead. Called by the palette's Instance step.
 *
 * Reopening the same Orbit Project keeps its draft and text and only swaps the target.
 */
export async function openOrbitDraft(
  router: AnyRouter,
  target: OrbitDraftTarget,
): Promise<DraftId | null> {
  if (!getClientSettings().orbitThreadsInPaletteEnabled) return null;
  const anchor = chooseOrbitDraftAnchor({
    orbitProjectId: target.projectId,
    orbitInstances: useEnvironmentProvider.getState().orbitInstances,
    savedEnvironmentIds: new Set(
      appAtomRegistry.get(environmentCatalog.catalogValueAtom).entries.keys(),
    ),
    primaryEnvironmentId: appAtomRegistry.get(primaryEnvironmentIdAtom),
  });
  if (anchor === null) return null;
  const logicalProjectKey = orbitDraftLogicalProjectKey(target.projectId);
  const store = useComposerDraftStore.getState();
  const existing = store.getDraftSessionByLogicalProjectKey(logicalProjectKey);
  const draftId = existing?.draftId ?? newDraftId();
  store.setLogicalProjectDraftThreadId(
    logicalProjectKey,
    scopeProjectRef(anchor, orbitDraftProjectId(target.projectId)),
    draftId,
    {
      threadId: existing?.threadId ?? newThreadId(),
      envMode: "local",
      branch: null,
      worktreePath: null,
      orbitTarget: target,
    },
  );
  await router.navigate({ to: "/draft/$draftId", params: { draftId } });
  return draftId;
}
