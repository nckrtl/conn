import type { EnvironmentId } from "@t3tools/contracts";
import { FolderGit2Icon, FolderGitIcon, FolderIcon } from "lucide-react";
import { useMemo, type ReactNode } from "react";

import {
  resolveCurrentWorkspaceLabel,
  resolveEnvModeLabel,
  type EnvMode,
} from "./BranchToolbar.logic";
import { useOrbitAvailability } from "../orbit/useOrbitAvailability";
import { OrbitLogoIcon } from "./OrbitLogoIcon";
import { PreviousWorktreeItemContent } from "./PreviousWorktreeItemContent";
import { MiddleTruncate } from "./ui/middle-truncate";

export const PREVIOUS_WORKTREE_OPTION = "previous-worktree";

export interface WorkspaceOption {
  readonly value: EnvMode | typeof PREVIOUS_WORKTREE_OPTION;
  /** Plain text, for a select trigger that shows the chosen value. */
  readonly label: string;
  readonly content: ReactNode;
  readonly disabled: boolean;
}

function OrbitInstanceItemContent({ note }: { note: string | null }) {
  const label = resolveEnvModeLabel("orbit");
  if (!note) {
    return (
      <span className="inline-flex items-center gap-1.5">
        <OrbitLogoIcon className="size-3" />
        {label}
      </span>
    );
  }
  return (
    <span className="flex min-w-0 items-start gap-1.5">
      <OrbitLogoIcon className="mt-1 size-3" />
      <span className="flex min-w-0 flex-col">
        <span>{label}</span>
        <span className="min-w-0 truncate text-xs text-muted-foreground">{note}</span>
      </span>
    </span>
  );
}

/**
 * The workspace choices every workspace menu offers. The wide composer strip,
 * the compact one, and the thread details panel all render this list, so a
 * choice can never depend on which layout is showing.
 */
export function useWorkspaceOptions({
  activeWorktreePath,
  effectiveEnvMode,
  forceNewWorktree,
  orbitTarget,
  previousWorktreeLabel,
  previousWorktreeBranch,
}: {
  activeWorktreePath: string | null;
  effectiveEnvMode: EnvMode;
  forceNewWorktree: boolean;
  /** Where the hidden Orbit check runs; null hides the Orbit option. */
  orbitTarget: { readonly environmentId: EnvironmentId; readonly projectRoot: string } | null;
  /** Null hides the previous-worktree option. */
  previousWorktreeLabel: string | null;
  previousWorktreeBranch: string | null;
}): { readonly options: readonly WorkspaceOption[]; readonly orbitNote: string | null } {
  // Checked up front (and cached), so the option never pops in or out while the picker is open.
  const orbitAvailability = useOrbitAvailability({
    environmentId: orbitTarget?.environmentId ?? ("" as EnvironmentId),
    projectRoot: orbitTarget?.projectRoot ?? null,
    enabled: orbitTarget !== null,
  });
  const orbitChecking = orbitAvailability !== null && "status" in orbitAvailability;
  const orbitResult = orbitAvailability === null || orbitChecking ? null : orbitAvailability;
  // Repositories Orbit does not manage never show the option.
  const showOrbit =
    orbitTarget !== null &&
    (effectiveEnvMode === "orbit" || (orbitResult !== null && orbitResult.hidden !== true));
  const orbitDisabled = orbitResult === null || !orbitResult.available;
  const orbitNote = orbitChecking
    ? "Checking Orbit…"
    : orbitResult !== null && !orbitResult.available && orbitResult.hidden !== true
      ? orbitResult.reason
      : null;

  const options = useMemo(() => {
    const currentLabel = resolveCurrentWorkspaceLabel(activeWorktreePath);
    const list: WorkspaceOption[] = [
      {
        value: "local",
        label: currentLabel,
        content: (
          <span className="flex min-w-0 items-center gap-1.5">
            {activeWorktreePath ? (
              <FolderGitIcon className="size-3" />
            ) : (
              <FolderIcon className="size-3" />
            )}
            <MiddleTruncate value={currentLabel} />
          </span>
        ),
        disabled: forceNewWorktree,
      },
      {
        value: "worktree",
        label: resolveEnvModeLabel("worktree"),
        content: (
          <span className="flex min-w-0 items-center gap-1.5">
            <FolderGit2Icon className="size-3" />
            <span className="min-w-0 truncate">{resolveEnvModeLabel("worktree")}</span>
          </span>
        ),
        disabled: false,
      },
    ];
    if (showOrbit) {
      list.push({
        value: "orbit",
        label: resolveEnvModeLabel("orbit"),
        content: <OrbitInstanceItemContent note={orbitNote} />,
        disabled: orbitDisabled && effectiveEnvMode !== "orbit",
      });
    }
    if (previousWorktreeLabel) {
      list.push({
        value: PREVIOUS_WORKTREE_OPTION,
        label: previousWorktreeLabel,
        content: <PreviousWorktreeItemContent branch={previousWorktreeBranch} />,
        disabled: false,
      });
    }
    return list;
  }, [
    activeWorktreePath,
    effectiveEnvMode,
    forceNewWorktree,
    orbitDisabled,
    orbitNote,
    previousWorktreeBranch,
    previousWorktreeLabel,
    showOrbit,
  ]);

  return { options, orbitNote };
}
