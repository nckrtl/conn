import { ServerIcon } from "lucide-react";

import { orbitDraftContextRow, type OrbitDraftTarget } from "../orbit/orbitDraft";
import { openOrbitInstanceStep } from "../orbit/orbitInstanceStep";
import { ComposerContextLabel } from "./ComposerContextLabel";
import { OrbitLogoIcon } from "./OrbitLogoIcon";
import { ComposerControl, ComposerControlIcon } from "./chat/ComposerControl";
import { Separator } from "./ui/separator";
import { Tooltip, TooltipPopup, TooltipTrigger } from "./ui/tooltip";

/**
 * Conn: the left side of the context row for an Orbit draft. Node as plain text (its menu waits
 * for Orbit), then the Instance, which reopens the palette's Instance step for the Project.
 */
export function BranchToolbarOrbitInstance({ target }: { target: OrbitDraftTarget }) {
  const row = orbitDraftContextRow(target);
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
    </div>
  );
}
