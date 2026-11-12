import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import type { OrbitThreadStart } from "@t3tools/client-runtime/orbit-gateway";
import { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { useNavigate, useRouter } from "@tanstack/react-router";
import { useEffect } from "react";

import { OrbitSetupCard } from "../components/chat/OrbitSetupCard";
import { Button } from "../components/ui/button";
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from "../components/ui/empty";
import { SidebarInset } from "../components/ui/sidebar";
import { toastManager } from "../components/ui/toast";
import { WorkspacePageHeader } from "../components/WorkspacePageHeader";
import { useComposerDraftStore } from "../composerDraftStore";
import { isElectron } from "../env";
import { useThreadShell } from "../state/entities";
import { buildThreadRouteParams } from "../threadRoutes";
import { openOrbitDraft } from "./openOrbitDraft";
import type { OrbitDraftTarget } from "./orbitDraft";
import { openOrbitInstanceStep } from "./orbitInstanceStep";
import { orbitSetupView } from "./orbitSetupView";
import { dismissOrbitThreadStart, retryOrbitThreadStart } from "./orbitThreadStarts";
import { useOrbitCreateOperations, useOrbitThreadStarts } from "./orbitThreadStartStore";

/** How long the handover waits for the thread to reach this window before it opens it anyway. */
const HANDOVER_WAIT_MS = 5_000;

/** The draft target a failed start goes back to, with its name, for Change name. */
export function orbitStartDraftTarget(start: OrbitThreadStart): OrbitDraftTarget {
  return {
    projectId: start.projectId,
    projectSlug: start.projectSlug,
    projectName: start.projectName ?? start.projectSlug,
    nodeName: start.nodeName,
    instanceKind: "new",
    instanceName: start.instanceName,
    existing: null,
    domainSuffix: start.instanceDomainSuffix ?? null,
  };
}

/**
 * Conn: the thread started in an Orbit Project, before the clone's server exists. It shows the
 * message and the setup card from the saved start, and hands over to the real thread once the
 * clone took the first message. A reload lands here again and the runner resumes the start.
 */
export function OrbitPendingThreadView({ startId }: { startId: string }) {
  const start = useOrbitThreadStarts(
    (state) => state.starts.find((entry) => entry.id === startId) ?? null,
  );
  const create = useOrbitCreateOperations((state) => state.byStart[startId] ?? null);
  const navigate = useNavigate();
  const router = useRouter();
  const handoverEnvironmentId = start?.sentAt != null ? start.environmentId : null;
  const handoverThreadId = handoverEnvironmentId === null ? null : (start?.threadId ?? null);
  const threadRef =
    handoverEnvironmentId !== null && handoverThreadId !== null
      ? scopeThreadRef(EnvironmentId.make(handoverEnvironmentId), ThreadId.make(handoverThreadId))
      : null;
  const threadShown = useThreadShell(threadRef) !== null;

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- hands the route over once the clone's thread reached this window
  useEffect(() => {
    if (handoverEnvironmentId === null || handoverThreadId === null) return;
    const ref = scopeThreadRef(
      EnvironmentId.make(handoverEnvironmentId),
      ThreadId.make(handoverThreadId),
    );
    const open = () =>
      void navigate({
        to: "/$environmentId/$threadId",
        params: buildThreadRouteParams(ref),
        replace: true,
      });
    if (threadShown) {
      open();
      return;
    }
    const timer = setTimeout(open, HANDOVER_WAIT_MS);
    return () => clearTimeout(timer);
  }, [navigate, handoverEnvironmentId, handoverThreadId, threadShown]);

  if (start === null) {
    return (
      <SidebarInset className="h-dvh">
        <WorkspacePageHeader electron={isElectron} />
        <Empty>
          <EmptyHeader>
            <EmptyTitle>This thread start is gone</EmptyTitle>
            <EmptyDescription>It was dismissed on this device.</EmptyDescription>
          </EmptyHeader>
          <Button variant="outline" onClick={() => void navigate({ to: "/" })}>
            New thread
          </Button>
        </Empty>
      </SidebarInset>
    );
  }

  const changeName = async () => {
    const target = orbitStartDraftTarget(start);
    const draftId = await openOrbitDraft(router, target);
    if (draftId === null) {
      toastManager.add({
        type: "error",
        title: "Could not reopen the draft",
        description: `Start a new thread in ${start.projectSlug} from the palette instead.`,
      });
      return;
    }
    const store = useComposerDraftStore.getState();
    store.setPrompt(draftId, start.message);
    if (start.modelSelection) store.setModelSelection(draftId, start.modelSelection);
    if (start.runtimeMode) store.setRuntimeMode(draftId, start.runtimeMode);
    if (start.interactionMode) store.setInteractionMode(draftId, start.interactionMode);
    // The taken name made no Instance, so only the saved start goes.
    dismissOrbitThreadStart(start.id);
    openOrbitInstanceStep(target);
  };

  return (
    <SidebarInset className="h-dvh" data-orbit-pending-thread={start.id}>
      <WorkspacePageHeader electron={isElectron}>
        <span className="min-w-0 truncate text-sm font-medium text-foreground">
          {start.message.split("\n")[0]}
        </span>
        <span className="shrink-0 text-xs text-muted-foreground">
          {start.instanceName} · {start.projectSlug}
        </span>
      </WorkspacePageHeader>
      <div className="min-h-0 flex-1 overflow-y-auto scrollbar-gutter-both">
        <div className="mx-auto flex w-full max-w-(--chat-content-max-width) flex-col px-4 pt-6">
          <div className="flex justify-end pb-4">
            <div
              data-orbit-pending-message
              className="max-w-[80%] rounded-bubble border-t border-t-(--message-highlight)! bg-message px-4 pt-2.5 pb-3 text-sm whitespace-pre-wrap text-message-foreground"
            >
              {start.message}
            </div>
          </div>
          <OrbitSetupCard
            view={orbitSetupView(start, create)}
            onRetry={() => retryOrbitThreadStart(start.id)}
            onChangeName={() => void changeName()}
            onDismiss={() => {
              dismissOrbitThreadStart(start.id);
              void navigate({ to: "/", replace: true });
            }}
          />
        </div>
      </div>
    </SidebarInset>
  );
}
