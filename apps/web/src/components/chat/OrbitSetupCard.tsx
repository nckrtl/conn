import type { ScopedThreadRef } from "@t3tools/contracts";
import { ChevronDownIcon, ChevronRightIcon } from "lucide-react";
import { useState, type ReactNode } from "react";

import { useOpenLink } from "~/browser/useOpenLink";
import { Button } from "~/components/ui/button";
import { useInstanceLinkContextMenu } from "~/orbit/useInstanceLinkContextMenu";
import { OrbitLaunchProgress } from "~/orbit/OrbitLaunchProgress";
import type { OrbitReadyView } from "~/orbit/orbitSetupView";
import { OrbitInstanceUrlChip } from "../BranchToolbarEnvModeSelector";
import type { OrbitReadyTimelineInput } from "./MessagesTimeline.logic";
import { WorkLogRow } from "./WorkLog";
import { StageIcon, stageRowClassName } from "./WorktreeSetupCard";

function OrbitDetailsGrid({ children }: { children: ReactNode }) {
  return (
    <dl
      className="mt-1 mb-1.5 ml-0.5 grid grid-cols-[auto_1fr] items-center gap-x-3 gap-y-0.5 text-xs text-muted-foreground"
      data-orbit-setup-details
    >
      {children}
    </dl>
  );
}

function DetailsFact({ label, value }: { label: string; value: string | null }) {
  if (value === null) return null;
  return (
    <>
      <dt className="text-foreground/80">{label}</dt>
      <dd className="min-w-0 truncate font-mono">{value}</dd>
    </>
  );
}

function DetailsToggle({ open, onToggle }: { open: boolean; onToggle: () => void }) {
  return (
    <Button type="button" size="xs" variant="ghost-muted" aria-expanded={open} onClick={onToggle}>
      {open ? <ChevronDownIcon aria-hidden /> : <ChevronRightIcon aria-hidden />}
      Details
    </Button>
  );
}

export function OrbitThreadSetupRow({ ready }: { ready: OrbitReadyTimelineInput }) {
  return ready.launch ? (
    <OrbitLaunchProgress launch={ready.launch} stale={ready.launchStale ?? false} />
  ) : (
    <OrbitReadyRow view={ready.view} threadRef={ready.threadRef} />
  );
}

/** The real thread's folded "Instance ready" row, its Details (open by default) and Conn's line. */
export function OrbitReadyRow({
  view,
  threadRef,
}: {
  view: OrbitReadyView;
  threadRef: ScopedThreadRef;
}) {
  const [detailsOpen, setDetailsOpen] = useState(true);
  const openLink = useOpenLink(threadRef);
  const showLinkMenu = useInstanceLinkContextMenu(threadRef);
  const label = "Instance ready";
  return (
    <section aria-label="Instance setup" data-orbit-ready>
      <WorkLogRow
        data-orbit-setup-stage="summary"
        data-orbit-setup-status="done"
        label={<span className={stageRowClassName("done")}>{label}</span>}
        trailing={<StageIcon status="done" />}
      />
      <div className="mt-0.5 -ml-1.5 flex items-center">
        <DetailsToggle open={detailsOpen} onToggle={() => setDetailsOpen((open) => !open)} />
      </div>
      {detailsOpen ? (
        <OrbitDetailsGrid>
          {view.url ? (
            <>
              <dt className="text-foreground/80">Preview</dt>
              <dd className="flex min-w-0">
                <OrbitInstanceUrlChip url={view.url} threadRef={threadRef} />
              </dd>
            </>
          ) : null}
          <DetailsFact label="Instance" value={view.instanceName} />
          <DetailsFact label="Node" value={view.nodeName} />
          <DetailsFact label="Branch" value={view.branch} />
          <DetailsFact label="Base" value={view.baseBranch} />
        </OrbitDetailsGrid>
      ) : null}
      {view.dependenciesLine ? (
        <p className="mb-1 ml-3.5 text-xs text-muted-foreground" data-orbit-dependencies-line>
          {view.dependenciesLine}
        </p>
      ) : null}
      {view.modelFallbackLine ? (
        <p className="mb-1 ml-3.5 text-xs text-muted-foreground" data-orbit-model-fallback>
          {view.modelFallbackLine}
        </p>
      ) : null}
      <p
        className="mt-3 text-sm leading-relaxed text-foreground"
        data-orbit-ready-line
        data-message-role="conn"
      >
        {view.url ? (
          <>
            Your Instance is ready. You can preview it at{" "}
            <a
              href={view.url}
              className="underline underline-offset-2"
              onClick={(event) => {
                event.preventDefault();
                void openLink(view.url!, { event }).catch((error: unknown) => console.error(error));
              }}
              onContextMenu={(event) => showLinkMenu(event, view.url!)}
            >
              {view.url}
            </a>{" "}
            while I work on your request.
          </>
        ) : (
          view.readyLine
        )}
      </p>
    </section>
  );
}
