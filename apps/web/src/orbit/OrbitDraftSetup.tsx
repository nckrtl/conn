import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { useNavigate, useRouter } from "@tanstack/react-router";

import { OrbitReadyRow, OrbitSetupCard } from "../components/chat/OrbitSetupCard";
import { useComposerDraftStore, type DraftId } from "../composerDraftStore";
import { useOrbitInstance } from "./environmentProvider";
import { orbitStartCardActions } from "./OrbitPendingThreadView";
import { orbitReadyView, orbitSetupView } from "./orbitSetupView";
import { linkedOrbitStart } from "./orbitThreadStarts";
import { useOrbitCreateOperations, useOrbitThreadStarts } from "./orbitThreadStartStore";

/** The plus's start of a draft, while it waits for the draft's first message. */
export function useOrbitDraftStart(draftId: DraftId | null) {
  return useOrbitThreadStarts((state) => linkedOrbitStart(state.starts, draftId));
}

/**
 * Conn: the setup of the Instance the palette's plus started, shown in its draft above the
 * composer: the same card as a pending thread's, then the folded "Instance ready" row once the
 * Instance is ready and still waits for the first message.
 */
export function OrbitDraftSetup({ draftId }: { draftId: DraftId }) {
  const start = useOrbitDraftStart(draftId);
  const create = useOrbitCreateOperations((state) =>
    start === null ? null : (state.byStart[start.id] ?? null),
  );
  const readyEnvironmentId =
    start !== null && start.connected && start.error === null ? start.environmentId : null;
  const url =
    useOrbitInstance(readyEnvironmentId === null ? null : EnvironmentId.make(readyEnvironmentId))
      ?.url ?? null;
  const navigate = useNavigate();
  const router = useRouter();
  if (start === null) return null;
  if (readyEnvironmentId !== null) {
    return (
      <div className="chat-content-lane" data-orbit-draft-setup="ready">
        <OrbitReadyRow
          view={orbitReadyView(start, url)}
          threadRef={scopeThreadRef(
            EnvironmentId.make(readyEnvironmentId),
            ThreadId.make(start.threadId),
          )}
        />
      </div>
    );
  }
  const actions = orbitStartCardActions({
    start,
    router,
    navigate: (to) => void navigate({ to, replace: true }),
    onLeave: () => useComposerDraftStore.getState().clearDraftThread(draftId),
  });
  return (
    <div className="chat-content-lane" data-orbit-draft-setup="running">
      <OrbitSetupCard view={orbitSetupView(start, create)} {...actions} />
    </div>
  );
}
