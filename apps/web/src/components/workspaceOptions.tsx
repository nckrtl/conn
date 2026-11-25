import { FolderGit2Icon, FolderGitIcon, FolderIcon } from "lucide-react";
import { type ReactNode } from "react";

import {
  resolveCurrentWorkspaceLabel,
  resolveEnvModeLabel,
  type EnvMode,
} from "./BranchToolbar.logic";
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

/**
 * The workspace choices every workspace menu offers. The wide composer strip,
 * the compact one, and the thread details panel all render this list, so a
 * choice can never depend on which layout is showing.
 */
export function buildWorkspaceOptions({
  activeWorktreePath,
  forceNewWorktree,
  previousWorktreeLabel,
  previousWorktreeBranch,
}: {
  activeWorktreePath: string | null;
  forceNewWorktree: boolean;
  /** Null hides the previous-worktree option. */
  previousWorktreeLabel: string | null;
  previousWorktreeBranch: string | null;
}): readonly WorkspaceOption[] {
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
  if (previousWorktreeLabel) {
    list.push({
      value: PREVIOUS_WORKTREE_OPTION,
      label: previousWorktreeLabel,
      content: <PreviousWorktreeItemContent branch={previousWorktreeBranch} />,
      disabled: false,
    });
  }
  return list;
}
