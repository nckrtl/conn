import type { EnvironmentId, ScopedThreadRef } from "@t3tools/contracts";
import { ComposerSelectControl } from "./chat/ComposerControl";
import { ComposerContextLabel } from "./ComposerContextLabel";
import { FolderGit2Icon, FolderGitIcon, FolderIcon, GlobeIcon } from "lucide-react";
import { memo, type MouseEvent as ReactMouseEvent } from "react";

import {
  resolveCurrentWorkspaceLabel,
  resolveEnvModeLabel,
  resolveLockedWorkspaceLabel,
  type EnvMode,
} from "./BranchToolbar.logic";
import { useOpenLink } from "../browser/useOpenLink";
import type { OrbitThreadInstance } from "../orbit/orbitThreadStore";
import { useComposerMenuProps } from "./chat/composerEventScope";
import { OrbitLogoIcon } from "./OrbitLogoIcon";
import { Badge } from "./ui/badge";
import { PREVIOUS_WORKTREE_OPTION, useWorkspaceOptions } from "./workspaceOptions";
import {
  Select,
  SelectGroup,
  SelectGroupLabel,
  SelectItem,
  SelectPopup,
  SelectValue,
} from "./ui/select";
import { Tooltip, TooltipPopup, TooltipTrigger } from "./ui/tooltip";
import { useAtomValue } from "@effect/atom-react";
import { shortcutLabelForCommand } from "../keybindings";
import { primaryServerKeybindingsAtom } from "../state/server";

function OrbitInstanceUrlChip({ url, threadRef }: { url: string; threadRef: ScopedThreadRef }) {
  const openLink = useOpenLink(threadRef);
  const host = url.replace(/^https?:\/\//, "").replace(/\/$/, "");
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <Badge
            variant="secondary"
            className="min-w-0 shrink font-normal"
            render={
              <a
                href={url}
                onClick={(event) => {
                  event.preventDefault();
                  void openLink(url, { event }).catch((error: unknown) => console.error(error));
                }}
              />
            }
          />
        }
      >
        <GlobeIcon />
        {/* A long domain must not push the other labels out; it collapses with them. */}
        <span
          data-composer-label
          className="min-w-0 max-w-40 group-data-[compact]/composer-context:max-w-0"
        >
          <span
            data-composer-label-motion
            className="block w-full min-w-0 max-w-40 truncate transition-opacity duration-180 ease-drawer group-data-[compact]/composer-context:opacity-0 motion-reduce:transition-none"
          >
            {host}
          </span>
        </span>
      </TooltipTrigger>
      <TooltipPopup>Open {url}</TooltipPopup>
    </Tooltip>
  );
}

function orbitThreadLabel(instance: OrbitThreadInstance): string {
  if (instance.phase === "registering") return "Orbit: setting up";
  if (instance.phase === "failed") return "Orbit: not registered";
  // The route's first label is the readable name, e.g. `login-redirect`.
  const host = instance.url?.replace(/^https?:\/\//, "").split(".")[0];
  return `Orbit: ${host || instance.instanceName}`;
}

function orbitThreadTooltip(instance: OrbitThreadInstance): string {
  if (instance.phase === "registering") {
    return `Worktree ${instance.checkoutPath}. Orbit registers it once the branch has its name.`;
  }
  if (instance.phase === "failed")
    return `Orbit could not register this worktree: ${instance.failure}`;
  return `Orbit instance ${instance.instanceName} in ${instance.checkoutPath}`;
}

interface BranchToolbarEnvModeSelectorProps {
  forceNewWorktree?: boolean;
  envLocked: boolean;
  effectiveEnvMode: EnvMode;
  activeWorktreePath: string | null;
  onEnvModeChange: (mode: EnvMode) => void;
  previousWorktreeLabel?: string | null;
  previousWorktreeBranch?: string | null;
  onUsePreviousWorktree?: () => void;
  /** Where the hidden Orbit check runs; omit to hide the Orbit option. */
  orbitTarget?: { readonly environmentId: EnvironmentId; readonly projectRoot: string } | null;
  /** The Orbit Instance this thread runs in, if any. */
  orbitThread?: OrbitThreadInstance | null;
  threadRef?: ScopedThreadRef | null;
}

export const BranchToolbarEnvModeSelector = memo(function BranchToolbarEnvModeSelector({
  forceNewWorktree = false,
  envLocked,
  effectiveEnvMode,
  activeWorktreePath,
  onEnvModeChange,
  previousWorktreeLabel,
  previousWorktreeBranch = null,
  onUsePreviousWorktree,
  orbitTarget = null,
  orbitThread = null,
  threadRef = null,
}: BranchToolbarEnvModeSelectorProps) {
  const composerFloatingLayerProps = useComposerMenuProps();
  const shortcutLabel = shortcutLabelForCommand(
    useAtomValue(primaryServerKeybindingsAtom),
    "composer.workspace",
  );
  const { options, orbitNote } = useWorkspaceOptions({
    activeWorktreePath,
    effectiveEnvMode,
    forceNewWorktree,
    orbitTarget,
    previousWorktreeLabel: onUsePreviousWorktree ? (previousWorktreeLabel ?? null) : null,
    previousWorktreeBranch,
  });

  const stopContextMenuMouseDown = (event: ReactMouseEvent) => {
    if (event.button !== 0 || event.ctrlKey) {
      event.stopPropagation();
    }
  };

  if (orbitThread !== null || (envLocked && effectiveEnvMode === "orbit")) {
    const lockedLabel = orbitThread ? orbitThreadLabel(orbitThread) : resolveEnvModeLabel("orbit");
    const lockedRow = (
      <span
        className="inline-flex h-7 min-w-0 items-center gap-1 border border-transparent px-1.75 font-normal text-muted-foreground/70 text-xs sm:h-6"
        data-composer-context-control
      >
        <OrbitLogoIcon className="size-3" />
        <ComposerContextLabel>{lockedLabel}</ComposerContextLabel>
      </span>
    );
    return (
      <span className="inline-flex min-w-0 items-center gap-1.5">
        <Tooltip>
          <TooltipTrigger render={lockedRow} />
          <TooltipPopup>
            {orbitThread
              ? orbitThreadTooltip(orbitThread)
              : "Creating an Orbit worktree for this thread"}
          </TooltipPopup>
        </Tooltip>
        {orbitThread?.url && threadRef ? (
          <OrbitInstanceUrlChip url={orbitThread.url} threadRef={threadRef} />
        ) : null}
      </span>
    );
  }

  if (envLocked || forceNewWorktree) {
    const lockedRow = (
      <span
        className="inline-flex h-7 min-w-0 items-center gap-1 border border-transparent px-1.75 font-normal text-muted-foreground/70 text-xs sm:h-6"
        data-composer-context-control
      >
        {activeWorktreePath ? (
          <FolderGitIcon className="size-3" />
        ) : effectiveEnvMode === "worktree" ? (
          <FolderGit2Icon className="size-3" />
        ) : (
          <FolderIcon className="size-3" />
        )}
        <ComposerContextLabel>
          {forceNewWorktree
            ? resolveEnvModeLabel("worktree")
            : resolveLockedWorkspaceLabel(activeWorktreePath, effectiveEnvMode)}
        </ComposerContextLabel>
      </span>
    );

    return (
      <Tooltip>
        <TooltipTrigger render={lockedRow} />
        <TooltipPopup>
          {forceNewWorktree
            ? "Each model starts in its own worktree."
            : resolveLockedWorkspaceLabel(activeWorktreePath, effectiveEnvMode)}
        </TooltipPopup>
      </Tooltip>
    );
  }

  return (
    <Select
      modal={false}
      value={effectiveEnvMode}
      onValueChange={(value: string | null) => {
        if (value === PREVIOUS_WORKTREE_OPTION) {
          onUsePreviousWorktree?.();
          return;
        }
        onEnvModeChange(value as EnvMode);
      }}
      items={options}
    >
      <Tooltip>
        <TooltipTrigger
          render={
            <ComposerSelectControl
              size="xs"
              className="min-w-0 shrink"
              aria-label="Workspace"
              data-composer-shortcut="composer.workspace"
              data-composer-context-control
              onMouseDownCapture={stopContextMenuMouseDown}
            />
          }
        >
          {effectiveEnvMode === "orbit" ? (
            <OrbitLogoIcon className="size-3" />
          ) : effectiveEnvMode === "worktree" ? (
            <FolderGit2Icon className="size-3" />
          ) : activeWorktreePath ? (
            <FolderGitIcon className="size-3" />
          ) : (
            <FolderIcon className="size-3" />
          )}
          <ComposerContextLabel>
            <SelectValue />
          </ComposerContextLabel>
        </TooltipTrigger>
        <TooltipPopup>
          {effectiveEnvMode === "orbit" && orbitNote
            ? `${resolveEnvModeLabel("orbit")}: ${orbitNote}`
            : effectiveEnvMode === "worktree" || effectiveEnvMode === "orbit"
              ? resolveEnvModeLabel(effectiveEnvMode)
              : resolveCurrentWorkspaceLabel(activeWorktreePath)}
          {shortcutLabel ? ` · ${shortcutLabel}` : null}
        </TooltipPopup>
      </Tooltip>
      <SelectPopup
        alignItemWithTrigger={false}
        {...composerFloatingLayerProps}
        className={options.length > 2 ? "w-[min(21rem,calc(100vw-2rem))]" : undefined}
      >
        <SelectGroup>
          <SelectGroupLabel>Workspace</SelectGroupLabel>
          {options.map((option) => (
            <SelectItem key={option.value} value={option.value} disabled={option.disabled}>
              {option.content}
            </SelectItem>
          ))}
        </SelectGroup>
      </SelectPopup>
    </Select>
  );
});
