import { scopeProjectRef } from "@t3tools/client-runtime/environment";
import type { AnyRouter } from "@tanstack/react-router";

import { useComposerDraftStore, type DraftId } from "../composerDraftStore";
import { environmentCatalog } from "../connection/catalog";
import { newDraftId, newThreadId } from "../lib/utils";
import { appAtomRegistry } from "../rpc/atomRegistry";
import { hostEnvironmentIdAtom, primaryEnvironmentIdAtom } from "../state/primaryEnvironment";
import { useEnvironmentProvider } from "./environmentProvider";
import {
  chooseOrbitDraftAnchor,
  orbitDraftLogicalProjectKey,
  orbitDraftProjectId,
  type OrbitDraftTarget,
} from "./orbitDraft";
import { orbitThreadStartBlockedReason, startOrbitInstanceFromPlus } from "./orbitThreadStarts";
import { updateStarts } from "./orbitThreadStartStore";

/**
 * Opens the draft for a thread in a new Instance or an unpaired one; a paired Instance uses a normal
 * draft in its `/srv/workspace` project. Reopening a Project keeps its draft and swaps the target.
 * Null only where `orbitThreadStartBlockedReason` names why: outside the desktop app or Orbit mode.
 */
export async function openOrbitDraft(
  router: AnyRouter,
  target: OrbitDraftTarget,
): Promise<DraftId | null> {
  const draftId = prepareOrbitDraft(target, false);
  if (draftId === null) return null;
  await router.navigate({ to: "/draft/$draftId", params: { draftId } });
  return draftId;
}

/**
 * The palette's plus (or Enter on the name): starts the new Instance's create at once, in a draft
 * of its own, and opens that draft. Its composer then gives the start its first message. The
 * Project's usual draft stays as it is, so the next plus starts another Instance.
 */
export async function openOrbitPlusCreate(
  router: AnyRouter,
  target: OrbitDraftTarget,
): Promise<DraftId | null> {
  if (target.instanceKind !== "new") return null;
  const draftId = prepareOrbitDraft(target, true);
  if (draftId === null) return null;
  if (startOrbitInstanceFromPlus({ target, draftId }) === null) {
    useComposerDraftStore.getState().clearDraftThread(draftId);
    return null;
  }
  await router.navigate({ to: "/draft/$draftId", params: { draftId } });
  return draftId;
}

/**
 * Gives a start the plus made a new draft of its own when its draft is gone (discarded, or
 * another device's), so its first message can still be written there.
 */
export async function reopenOrbitPlusDraft(
  router: AnyRouter,
  startId: string,
  target: OrbitDraftTarget,
): Promise<DraftId | null> {
  const draftId = prepareOrbitDraft(target, true);
  if (draftId === null) return null;
  updateStarts((starts) =>
    starts.map((start) => (start.id === startId ? { ...start, draftId } : start)),
  );
  await router.navigate({ to: "/draft/$draftId", params: { draftId }, replace: true });
  return draftId;
}

/** Saves the draft and its target; `own` gives it a key of its own, with no kept branch. */
function prepareOrbitDraft(target: OrbitDraftTarget, own: boolean): DraftId | null {
  if (orbitThreadStartBlockedReason() !== null) return null;
  const anchor = chooseOrbitDraftAnchor({
    orbitProjectId: target.projectId,
    orbitInstances: useEnvironmentProvider.getState().orbitInstances,
    savedEnvironments: appAtomRegistry.get(environmentCatalog.catalogValueAtom).entries,
    primaryEnvironmentId: appAtomRegistry.get(primaryEnvironmentIdAtom),
    hostEnvironmentId: appAtomRegistry.get(hostEnvironmentIdAtom),
  });
  const ownDraftId = own ? newDraftId() : null;
  const logicalProjectKey =
    ownDraftId === null
      ? orbitDraftLogicalProjectKey(target.projectId)
      : `${orbitDraftLogicalProjectKey(target.projectId)}:plus:${ownDraftId}`;
  const store = useComposerDraftStore.getState();
  const existing = own ? null : store.getDraftSessionByLogicalProjectKey(logicalProjectKey);
  const draftId = ownDraftId ?? existing?.draftId ?? newDraftId();
  // A new Instance keeps the branch chosen for the Project's draft unless the target sets one.
  // The plus always creates from the default branch: no branch control is reachable before it.
  const previous = existing?.orbitTarget;
  const keptBranch =
    !own &&
    target.instanceKind === "new" &&
    target.branch === undefined &&
    previous?.projectId === target.projectId
      ? {
          ...(previous.branch ? { branch: previous.branch } : {}),
          ...(previous.defaultBranch ? { defaultBranch: previous.defaultBranch } : {}),
        }
      : {};
  store.setLogicalProjectDraftThreadId(
    logicalProjectKey,
    scopeProjectRef(anchor, orbitDraftProjectId(target.projectId)),
    draftId,
    {
      threadId: existing?.threadId ?? newThreadId(),
      envMode: "local",
      branch: null,
      worktreePath: null,
      orbitTarget: own ? { ...target, branch: null } : { ...target, ...keptBranch },
    },
  );
  return draftId;
}
