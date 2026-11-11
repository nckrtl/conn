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
  THREAD_DETAILS_PANEL_LOCKED_ROW_CLASS,
  THREAD_DETAILS_PANEL_ROW_CLASS,
} from "./threadDetailsPanelStyles";

/**
 * Characters of an Instance name kept after the ellipsis. Thread-start clones
 * end in a random 6-character suffix (`list-the-files-here-62b311`), which is
 * the part that tells two clones apart.
 */
const ORBIT_INSTANCE_NAME_TAIL_LENGTH = 6;

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
      <span
        className={cn("inline-flex items-center", THREAD_DETAILS_PANEL_LOCKED_ROW_CLASS)}
        aria-label={description}
        data-thread-panel-orbit-instance
      >
        <Tooltip>
          <TooltipTrigger render={<span className="inline-flex shrink-0" />}>
            <OrbitLogoIcon className={THREAD_DETAILS_PANEL_ICON_CLASS} />
          </TooltipTrigger>
          <TooltipPopup>{description}</TooltipPopup>
        </Tooltip>
        <ComposerContextLabel displayMode="panel">{project}</ComposerContextLabel>
        <OrbitPlacement
          instanceName={orbitInstance.instanceName}
          nodeName={orbitInstance.nodeName}
          description={description}
        />
      </span>
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
 * `list-the-files-…62b311 · beast` and the Node always shows.
 */
function OrbitPlacement({
  instanceName,
  nodeName,
  description,
}: {
  instanceName: string | undefined;
  nodeName: string | undefined;
  description: string;
}) {
  if (instanceName === undefined && nodeName === undefined) return null;
  const splitAt =
    instanceName !== undefined && instanceName.length > ORBIT_INSTANCE_NAME_TAIL_LENGTH
      ? instanceName.length - ORBIT_INSTANCE_NAME_TAIL_LENGTH
      : 0;
  const nodeText = nodeName === undefined ? undefined : instanceName ? ` · ${nodeName}` : nodeName;
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <span
            className="flex min-w-0 max-w-[55%] shrink overflow-x-clip whitespace-pre text-muted-foreground"
            data-thread-panel-orbit-placement
          />
        }
      >
        {instanceName ? (
          <>
            <span className="min-w-0 truncate" data-orbit-instance-name-head>
              {instanceName.slice(0, splitAt)}
            </span>
            <span className="shrink-0" data-orbit-instance-name-tail>
              {instanceName.slice(splitAt)}
            </span>
          </>
        ) : null}
        {nodeText ? (
          <span className="shrink-0" data-orbit-node-name>
            {nodeText}
          </span>
        ) : null}
      </TooltipTrigger>
      <TooltipPopup>{description}</TooltipPopup>
    </Tooltip>
  );
}
