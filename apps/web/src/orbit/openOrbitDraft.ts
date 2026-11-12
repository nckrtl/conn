import { scopeProjectRef } from "@t3tools/client-runtime/environment";
import type { AnyRouter } from "@tanstack/react-router";

import { useComposerDraftStore, type DraftId } from "../composerDraftStore";
import { environmentCatalog } from "../connection/catalog";
import { newDraftId, newThreadId } from "../lib/utils";
import { appAtomRegistry } from "../rpc/atomRegistry";
import { primaryEnvironmentIdAtom } from "../state/primaryEnvironment";
import { orbitThreadsAvailableNow, useEnvironmentProvider } from "./environmentProvider";
import {
  chooseOrbitDraftAnchor,
  orbitDraftLogicalProjectKey,
  orbitDraftProjectId,
  type OrbitDraftTarget,
} from "./orbitDraft";

/**
 * Opens the draft for a thread in a new Instance or an unpaired one; a paired Instance uses a normal
 * draft in its `/srv/workspace` project. Reopening a Project keeps its draft and swaps the target.
 * Null outside the desktop app in Orbit mode, or when no environment can anchor the draft.
 */
export async function openOrbitDraft(
  router: AnyRouter,
  target: OrbitDraftTarget,
): Promise<DraftId | null> {
  if (!orbitThreadsAvailableNow()) return null;
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
