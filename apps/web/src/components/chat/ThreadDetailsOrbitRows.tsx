import type { OrbitInstanceDescriptor } from "@t3tools/contracts";
import { GlobeIcon } from "lucide-react";
import type { MouseEvent as ReactMouseEvent } from "react";

import { isWebUrl } from "../../browser/browserLinkTarget";
import { cn } from "../../lib/utils";
import { ComposerContextLabel } from "../ComposerContextLabel";
import { OrbitLogoIcon } from "../OrbitLogoIcon";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import {
  THREAD_DETAILS_PANEL_ICON_CLASS,
  THREAD_DETAILS_PANEL_LABEL_CLASS,
  THREAD_DETAILS_PANEL_LOCKED_ROW_CLASS,
  THREAD_DETAILS_PANEL_ROW_CLASS,
} from "./threadDetailsPanelStyles";

/**
 * Characters of an Instance name kept after the ellipsis. Thread-start clones
 * end in a random 6-character suffix (`list-the-files-here-62b311`), which is
 * the part that tells two clones apart.
 */
const ORBIT_INSTANCE_NAME_TAIL_LENGTH = 6;

/**
 * The Project label's trimmed text box, so both sit on one baseline. It clips
 * only sideways, so descenders still draw; `whitespace-pre` keeps the space
 * before " · node" that `truncate` would drop.
 */
const ORBIT_PLACEMENT_TEXT_CLASS = `whitespace-pre ${THREAD_DETAILS_PANEL_LABEL_CLASS}`;

/** The machine row of a thread whose server runs in an Orbit Instance: Project, Instance, Node and URL. */
export function ThreadDetailsOrbitRows({
  orbitInstance,
  onOpenUrl,
}: {
  orbitInstance: OrbitInstanceDescriptor;
  onOpenUrl: (url: string, event: ReactMouseEvent) => void;
}) {
  const project =
    orbitInstance.projectName ?? orbitInstance.projectSlug ?? `Project ${orbitInstance.projectId}`;
  const description = [
    `Orbit Project ${project}`,
    orbitInstance.instanceName && `Instance ${orbitInstance.instanceName}`,
    orbitInstance.nodeName && `Node ${orbitInstance.nodeName}`,
  ]
    .filter(Boolean)
    .join(", ");
  // Another server build could send any scheme; only web links render as a link.
  const url = orbitInstance.url && isWebUrl(orbitInstance.url) ? orbitInstance.url : null;
  return (
    <>
      {/* One focusable trigger for the whole row, so the full text also opens from the keyboard. */}
      <Tooltip>
        <TooltipTrigger
          render={
            <span
              role="group"
              tabIndex={0}
              className={cn(
                "inline-flex items-center outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring",
                THREAD_DETAILS_PANEL_LOCKED_ROW_CLASS,
              )}
              aria-label={description}
              data-thread-panel-orbit-instance
            />
          }
        >
          <OrbitLogoIcon className={THREAD_DETAILS_PANEL_ICON_CLASS} />
          <ComposerContextLabel displayMode="panel">{project}</ComposerContextLabel>
          <OrbitPlacement
            instanceName={orbitInstance.instanceName || undefined}
            nodeName={orbitInstance.nodeName || undefined}
          />
        </TooltipTrigger>
        <TooltipPopup>{description}</TooltipPopup>
      </Tooltip>
      {url ? (
        <a
          href={url}
          className={cn("inline-flex items-center", THREAD_DETAILS_PANEL_ROW_CLASS)}
          aria-label={`Open ${url}`}
          onClick={(event) => {
            event.preventDefault();
            onOpenUrl(url, event);
          }}
        >
          <GlobeIcon className={THREAD_DETAILS_PANEL_ICON_CLASS} aria-hidden />
          <ComposerContextLabel displayMode="panel">
            {url.replace(/^https?:\/\//, "").replace(/\/$/, "")}
          </ComposerContextLabel>
        </a>
      ) : null}
    </>
  );
}

/**
 * "<instance> · <node>". CSS can only cut text at the end, so the name is split
 * into a head that truncates and a tail that stays: a long name reads
 * `list-the-files-…62b311 · beast` and the Node always shows. Only a Node too
 * long for the row is cut, with its own "…".
 */
function OrbitPlacement({
  instanceName,
  nodeName,
}: {
  /** Empty names arrive as undefined. */
  instanceName: string | undefined;
  nodeName: string | undefined;
}) {
  if (instanceName === undefined && nodeName === undefined) return null;
  const splitAt = Math.max(0, (instanceName?.length ?? 0) - ORBIT_INSTANCE_NAME_TAIL_LENGTH);
  const nodeText = nodeName && (instanceName ? ` · ${nodeName}` : nodeName);
  return (
    <span
      className="flex min-w-0 max-w-[55%] shrink overflow-x-clip whitespace-pre text-muted-foreground"
      data-thread-panel-orbit-placement
    >
      {instanceName ? (
        <span
          className={cn("min-w-0 truncate", ORBIT_PLACEMENT_TEXT_CLASS)}
          data-orbit-instance-name-head
        >
          {instanceName.slice(0, splitAt)}
        </span>
      ) : null}
      {/* Never shrinks past the row, so only the head gives up space; a Node too long for the row truncates inside. */}
      <span className="flex min-w-0 max-w-full shrink-0">
        {instanceName ? (
          <span
            className={cn("shrink-0", ORBIT_PLACEMENT_TEXT_CLASS)}
            data-orbit-instance-name-tail
          >
            {instanceName.slice(splitAt)}
          </span>
        ) : null}
        {nodeText ? (
          <span className={cn("min-w-0 truncate", ORBIT_PLACEMENT_TEXT_CLASS)} data-orbit-node-name>
            {nodeText}
          </span>
        ) : null}
      </span>
    </span>
  );
}
