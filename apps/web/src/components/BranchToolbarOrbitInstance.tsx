import { GitBranchIcon, ServerIcon } from "lucide-react";

import type { DraftId } from "../composerDraftStore";
import { orbitDraftContextRow, type OrbitDraftTarget } from "../orbit/orbitDraft";
import { BranchToolbarOrbitBranch } from "./BranchToolbarOrbitBranch";
import { useOrbitDraftStart } from "../orbit/OrbitDraftSetup";
import { orbitBranchControlLabel, orbitDefaultBranches } from "../orbit/orbitBranchControl";
import { MiddleTruncate } from "./ui/middle-truncate";
import { openOrbitInstanceStep } from "../orbit/orbitInstanceStep";
import { ComposerContextLabel } from "./ComposerContextLabel";
import { OrbitLogoIcon } from "./OrbitLogoIcon";
import { ComposerControl, ComposerControlIcon } from "./chat/ComposerControl";
import { Separator } from "./ui/separator";
import { Tooltip, TooltipPopup, TooltipTrigger } from "./ui/tooltip";

/**
 * Conn: the left side of the context row for an Orbit draft. Node as plain text (its menu waits
 * for Orbit), then the Instance, which reopens the palette's Instance step for the Project, then
 * for a new Instance the branch control when `onTargetChange` is given (a draft can be edited).
 */
export function BranchToolbarOrbitInstance({
  target,
  draftId,
  onTargetChange,
}: {
  target: OrbitDraftTarget;
  draftId?: DraftId | undefined;
  onTargetChange?: ((patch: Partial<OrbitDraftTarget>) => void) | undefined;
}) {
  const row = orbitDraftContextRow(target);
  // The plus started this Instance's create: its branch is fixed, so the row only names it.
  const started = useOrbitDraftStart(draftId ?? null);
  const startedBranch =
    started === null
      ? null
      : (started.resultBranch ??
        orbitBranchControlLabel({
          branch: null,
          defaultBranch:
            orbitDefaultBranches.known(target.projectId) ?? target.defaultBranch ?? null,
        }));
  return (
    <div
      className="flex min-h-7 min-w-10 flex-1 items-center gap-1 sm:min-h-6"
      data-orbit-draft-row
    >
      <span
        className="inline-flex h-7 items-center gap-1.5 px-1.75 sm:h-6"
        data-composer-context-control
      >
        <ComposerControlIcon icon={ServerIcon} size="xs" />
        <ComposerContextLabel>{row.nodeLabel}</ComposerContextLabel>
      </span>
      <Separator orientation="vertical" className="mx-0.5 h-3.5!" data-composer-context-control />
      <Tooltip>
        <TooltipTrigger
          render={
            <ComposerControl
              size="xs"
              data-composer-context-control
              aria-label={row.instanceTitle}
              onClick={() => openOrbitInstanceStep(target)}
            />
          }
        >
          <OrbitLogoIcon className="size-3" />
          <ComposerContextLabel>{row.instanceLabel}</ComposerContextLabel>
        </TooltipTrigger>
        <TooltipPopup>{row.instanceTitle}</TooltipPopup>
      </Tooltip>
      {startedBranch !== null ? (
        <>
          <Separator
            orientation="vertical"
            className="mx-0.5 h-3.5!"
            data-composer-context-control
          />
          <span
            className="inline-flex h-7 min-w-0 items-center gap-1.5 px-1.75 sm:h-6"
            data-composer-context-control
            data-orbit-branch-fixed
          >
            <ComposerControlIcon icon={GitBranchIcon} size="xs" />
            <ComposerContextLabel>
              <MiddleTruncate value={startedBranch} variant="cap-aligned" className="w-full" />
            </ComposerContextLabel>
          </span>
        </>
      ) : onTargetChange && target.instanceKind === "new" ? (
        <>
          <Separator
            orientation="vertical"
            className="mx-0.5 h-3.5!"
            data-composer-context-control
          />
          <BranchToolbarOrbitBranch
            key={target.projectId}
            target={target}
            draftId={draftId}
            onTargetChange={onTargetChange}
          />
        </>
      ) : null}
    </div>
  );
}
