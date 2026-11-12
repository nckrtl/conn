import type { ScopedThreadRef } from "@t3tools/contracts";
import {
  ChevronDownIcon,
  ChevronRightIcon,
  ExternalLinkIcon,
  GitBranchIcon,
  PencilIcon,
  RotateCcwIcon,
  XIcon,
} from "lucide-react";
import { useState } from "react";

import { useOpenLink } from "~/browser/useOpenLink";
import { Button } from "~/components/ui/button";
import { Tooltip, TooltipPopup, TooltipTrigger } from "~/components/ui/tooltip";
import { cn } from "~/lib/utils";
import { useInstanceLinkContextMenu } from "~/orbit/useInstanceLinkContextMenu";
import { observeVisibleAnimation } from "~/lib/visibleAnimation";
import {
  ORBIT_INSTANCE_STAYS_LINE,
  ORBIT_SETUP_FAILED_TITLE,
  type OrbitReadyView,
  type OrbitSetupView,
  type OrbitSetupViewStage,
} from "~/orbit/orbitSetupView";
import { formatDuration } from "@t3tools/shared/orchestrationTiming";
import { OrbitInstanceUrlChip } from "../BranchToolbarEnvModeSelector";
import { WorkLogRow } from "./WorkLog";
import { Elapsed, ShimmerOverlay, StageIcon, stageRowClassName } from "./WorktreeSetupCard";

/**
 * Conn: the setup card of a thread started in an Orbit Project, in the look of WorktreeSetupCard.
 * It renders a client-built view, so the worktree wire contract stays as it is.
 */
function OrbitStageRow({ stage, live }: { stage: OrbitSetupViewStage; live: boolean }) {
  const running = stage.status === "running";
  return (
    <WorkLogRow
      data-orbit-setup-stage={stage.id}
      data-orbit-setup-status={stage.status}
      icon={
        <span className={cn("text-icon-muted", stage.status === "pending" && "opacity-40")}>
          <StageIcon status={stage.status} />
        </span>
      }
      label={
        <span
          ref={running ? observeVisibleAnimation : undefined}
          className={cn("relative block truncate", stageRowClassName(stage.status))}
        >
          {stage.label}
          {running ? <ShimmerOverlay>{stage.label}</ShimmerOverlay> : null}
        </span>
      }
      trailing={
        stage.status === "pending" ? null : (
          <>
            {stage.detail ? (
              <span className="min-w-0 truncate text-xs text-muted-foreground">{stage.detail}</span>
            ) : null}
            <span className="shrink-0 text-xs text-muted-foreground tabular-nums empty:hidden">
              <Elapsed startedAt={stage.startedAt} endedAt={stage.endedAt} live={live} />
            </span>
          </>
        )
      }
    />
  );
}

export function OrbitSetupCard({
  view,
  onRetry,
  onChangeName,
  onChangeBranch,
  onOpenInstance,
  onDismiss,
}: {
  view: OrbitSetupView;
  onRetry: () => void;
  onChangeName: () => void;
  onChangeBranch: () => void;
  onOpenInstance: (instance: { readonly id: number; readonly name: string }) => void;
  onDismiss: () => void;
}) {
  const failed = view.phase === "failed";
  return (
    <section aria-label="Instance setup" data-orbit-setup-phase={view.phase}>
      {failed ? (
        <div className="border-b border-(--shell-divider)! pb-2 pt-1">
          <div className="flex h-6 items-baseline px-1 text-sm leading-relaxed text-destructive-foreground">
            {ORBIT_SETUP_FAILED_TITLE}
          </div>
        </div>
      ) : null}
      <div className={failed ? "pt-1.5" : undefined}>
        {view.stages.map((stage) => (
          <div key={stage.id}>
            <OrbitStageRow stage={stage} live={view.phase === "running"} />
            {stage.subDetail && (stage.status === "running" || stage.status === "failed") ? (
              <p className="ml-8 text-xs text-muted-foreground" data-orbit-setup-subdetail>
                {stage.subDetail}
              </p>
            ) : null}
          </div>
        ))}
      </div>
      {failed && view.error ? (
        <p className="mt-1 ml-8 text-xs break-words text-muted-foreground">{view.error}</p>
      ) : null}
      {failed && view.errorDetailLine ? (
        <Tooltip>
          <TooltipTrigger
            render={
              <p
                className="mt-0.5 ml-8 truncate font-mono text-xs text-muted-foreground/70"
                data-orbit-setup-error-detail
              />
            }
          >
            {view.errorDetailLine}
          </TooltipTrigger>
          <TooltipPopup side="top" className="max-w-96">
            <span className="break-words font-mono">{view.errorDetailLine}</span>
          </TooltipPopup>
        </Tooltip>
      ) : null}
      {view.instanceStays ? (
        <p className="mt-1 ml-8 text-xs text-muted-foreground">{ORBIT_INSTANCE_STAYS_LINE}</p>
      ) : null}
      {failed ? (
        <div className="mt-1 ml-[calc(--spacing(6)+2px-(--spacing(2)-1px))] flex flex-wrap items-center gap-0.5">
          {view.canRetry ? (
            <Button type="button" size="xs" variant="ghost-muted" onClick={onRetry}>
              <RotateCcwIcon aria-hidden />
              Retry
            </Button>
          ) : null}
          {view.canChangeName ? (
            <Button type="button" size="xs" variant="ghost-muted" onClick={onChangeName}>
              <PencilIcon aria-hidden />
              Change name
            </Button>
          ) : null}
          {view.canChangeBranch ? (
            <Button type="button" size="xs" variant="ghost-muted" onClick={onChangeBranch}>
              <GitBranchIcon aria-hidden />
              Change branch
            </Button>
          ) : null}
          {view.openInstance ? (
            <Button
              type="button"
              size="xs"
              variant="ghost-muted"
              onClick={() => onOpenInstance(view.openInstance!)}
            >
              <ExternalLinkIcon aria-hidden />
              Open {view.openInstance.name}
            </Button>
          ) : null}
          <Button type="button" size="xs" variant="ghost-muted" onClick={onDismiss}>
            <XIcon aria-hidden />
            Dismiss
          </Button>
        </div>
      ) : null}
    </section>
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
        icon={
          <span className="text-icon-muted">
            <StageIcon status="done" />
          </span>
        }
        label={<span className={stageRowClassName("done")}>{label}</span>}
        trailing={
          view.readyMs === null ? null : (
            <span className="shrink-0 text-xs text-muted-foreground tabular-nums">
              {formatDuration(view.readyMs)}
            </span>
          )
        }
      />
      <div className="mt-0.5 ml-[calc(--spacing(6)+2px-(--spacing(2)-1px))] flex items-center">
        <Button
          type="button"
          size="xs"
          variant="ghost-muted"
          aria-expanded={detailsOpen}
          onClick={() => setDetailsOpen((open) => !open)}
        >
          {detailsOpen ? <ChevronDownIcon aria-hidden /> : <ChevronRightIcon aria-hidden />}
          Details
        </Button>
      </div>
      {detailsOpen ? (
        <dl className="mt-1 mb-1.5 ml-8 grid grid-cols-[auto_1fr] items-center gap-x-3 gap-y-0.5 text-xs text-muted-foreground">
          {view.url ? (
            <>
              <dt className="text-foreground/80">Preview</dt>
              <dd className="flex min-w-0">
                <OrbitInstanceUrlChip url={view.url} threadRef={threadRef} />
              </dd>
            </>
          ) : null}
          <dt className="text-foreground/80">Instance</dt>
          <dd className="min-w-0 truncate font-mono">{view.instanceName}</dd>
          <dt className="text-foreground/80">Node</dt>
          <dd className="min-w-0 truncate font-mono">{view.nodeName}</dd>
          {view.branch ? (
            <>
              <dt className="text-foreground/80">Branch</dt>
              <dd className="min-w-0 truncate font-mono">{view.branch}</dd>
            </>
          ) : null}
          {view.baseBranch ? (
            <>
              <dt className="text-foreground/80">Base</dt>
              <dd className="min-w-0 truncate font-mono">{view.baseBranch}</dd>
            </>
          ) : null}
        </dl>
      ) : null}
      {view.dependenciesLine ? (
        <p className="mb-1 ml-8 text-xs text-muted-foreground" data-orbit-dependencies-line>
          {view.dependenciesLine}
        </p>
      ) : null}
      {view.modelFallbackLine ? (
        <p className="mb-1 ml-8 text-xs text-muted-foreground" data-orbit-model-fallback>
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
