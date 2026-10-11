import { useAtomValue } from "@effect/atom-react";
import { scopeProjectRef } from "@t3tools/client-runtime/environment";
import type { ScopedThreadRef } from "@t3tools/contracts";
import { useMemo } from "react";

import { useComposerDraftStore } from "~/composerDraftStore";
import { RenderErrorBoundary } from "~/components/RenderErrorBoundary";
import { useOpenInPreferredEditor } from "~/editorPreferences";
import { createTerminalOrbitTransport } from "~/orbit/orbitTransport";
import { useProject, useThreadShell } from "~/state/entities";
import { serverEnvironment } from "~/state/server";

import { openDatabaseQuery } from "~/database/databaseStore";
import { isPathInsideProject } from "~/lib/pathInsideProject";

import { browserToolbarSource } from "./bridge";
import { ToolbarProvider, type ToolbarSource } from "./context";
import { gatewayOrbitSource, type OrbitSource } from "./orbit";
import { useLaravelToolbarStore } from "./store";
import { ToolbarBar } from "./ui/ToolbarBar";

// One source per machine, project and domain, so remounting the bar does not ask Orbit again.
const orbitSources = new Map<string, OrbitSource>();

function hostname(url: string): string | null {
  try {
    return new URL(url).hostname || null;
  } catch {
    return null;
  }
}

function useThreadProject(threadRef: ScopedThreadRef) {
  const serverThread = useThreadShell(threadRef);
  const draftThread = useComposerDraftStore((store) => store.getDraftThreadByRef(threadRef));
  const thread = serverThread ?? draftThread;
  return useProject(thread ? scopeProjectRef(thread.environmentId, thread.projectId) : null);
}

/** Orbit calls run on the thread's machine, from its project folder (see ~/orbit/orbitTransport.ts). */
function useOrbitSource(threadRef: ScopedThreadRef, pageUrl: string): OrbitSource | null {
  const project = useThreadProject(threadRef);
  const domain = hostname(pageUrl);
  const environmentId = project?.environmentId ?? null;
  const cwd = project?.workspaceRoot ?? null;
  return useMemo(() => {
    if (!environmentId || !cwd || !domain) return null;
    const key = `${environmentId}\u0000${cwd}\u0000${domain}`;
    let source = orbitSources.get(key);
    if (!source) {
      source = gatewayOrbitSource(createTerminalOrbitTransport({ environmentId, cwd }), domain);
      orbitSources.set(key, source);
    }
    return source;
  }, [cwd, domain, environmentId]);
}

/**
 * The Laravel Toolbar under a browser tab's page, or under the API panel. Renders nothing
 * until toolbar data arrives, so non-Laravel pages keep the full height.
 */
export function BrowserLaravelToolbar({
  tabId,
  threadRef,
  pageUrl,
  fetchDetails,
}: {
  tabId: string;
  threadRef: ScopedThreadRef;
  pageUrl: string;
  /** Loads history requests when there is no browser page to fetch them in (API panel). */
  fetchDetails?: ToolbarSource["fetchDetails"] | undefined;
}) {
  const tab = useLaravelToolbarStore((state) => state.byTabId[tabId]);
  const serverConfig = useAtomValue(serverEnvironment.configValueAtom(threadRef.environmentId));
  const openInPreferredEditor = useOpenInPreferredEditor(
    threadRef.environmentId,
    serverConfig?.availableEditors ?? [],
  );
  const orbit = useOrbitSource(threadRef, pageUrl);
  const projectRoot = useThreadProject(threadRef)?.workspaceRoot ?? null;
  // Source paths come from the server that runs the page; they open when this thread's
  // environment is that machine. The page supplies them, so only paths inside the project open.
  const source = useMemo(
    () => ({
      ...browserToolbarSource(tabId, (target) => {
        if (projectRoot && isPathInsideProject(target, projectRoot)) {
          void openInPreferredEditor(target);
        }
      }),
      ...(fetchDetails ? { fetchDetails } : {}),
      openQuery: (sql: string) => openDatabaseQuery(threadRef, sql),
      orbit,
    }),
    [fetchDetails, openInPreferredEditor, orbit, projectRoot, tabId, threadRef],
  );
  if (!tab?.currentId) return null;
  // The payload comes from the page. Data the bar cannot show hides the bar until new data
  // arrives; it never takes the app down.
  return (
    <RenderErrorBoundary fallback={null} resetKeys={[tab]}>
      <ToolbarProvider tabId={tabId} source={source}>
        <ToolbarBar />
      </ToolbarProvider>
    </RenderErrorBoundary>
  );
}
