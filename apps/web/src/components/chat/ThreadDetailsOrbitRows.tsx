import type { OrbitInstanceDescriptor } from "@t3tools/contracts";
import { GlobeIcon } from "lucide-react";
import type { MouseEvent as ReactMouseEvent } from "react";

import { cn } from "../../lib/utils";
import { ComposerContextLabel } from "../ComposerContextLabel";
import { OrbitLogoIcon } from "../OrbitLogoIcon";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import {
  THREAD_DETAILS_PANEL_ICON_CLASS,
  THREAD_DETAILS_PANEL_LOCKED_ROW_CLASS,
  THREAD_DETAILS_PANEL_ROW_CLASS,
} from "./threadDetailsPanelStyles";

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
  const placement = [orbitInstance.instanceName, orbitInstance.nodeName]
    .filter((part) => part !== undefined)
    .join(" · ");
  const description = [
    `Orbit Project ${project}`,
    orbitInstance.instanceName && `Instance ${orbitInstance.instanceName}`,
    orbitInstance.nodeName && `Node ${orbitInstance.nodeName}`,
  ]
    .filter(Boolean)
    .join(", ");
  const url = orbitInstance.url;
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
        {placement ? (
          <span className="min-w-0 max-w-[55%] shrink truncate text-muted-foreground">
            {placement}
          </span>
        ) : null}
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
