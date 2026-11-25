import { lazy, Suspense, useMemo, useState } from "react";
import {
  buildTurnDiffTree,
  type TurnDiffTreeNode,
  type TurnDiffStat,
} from "../../../web/src/lib/turnDiffTree";
import { Icon } from "./Icon";
import type { LabEntry } from "../data/fixtures";
import "./CardHeader.css";
import "./FileChangesCard.css";

const FilePatch = lazy(() => import("./FilePatch"));
const countFormat = new Intl.NumberFormat("en", { notation: "compact", maximumFractionDigits: 1 });

export function FileChangeStats({ additions, deletions }: TurnDiffStat) {
  return (
    <span className="m-change-stats" aria-label={`${additions} additions, ${deletions} deletions`}>
      <span>+{countFormat.format(additions).toLowerCase()}</span>
      <span>−{countFormat.format(deletions).toLowerCase()}</span>
    </span>
  );
}

function folderPaths(nodes: readonly TurnDiffTreeNode[]): string[] {
  return nodes.flatMap((node) =>
    node.kind === "directory" ? [node.path, ...folderPaths(node.children)] : [],
  );
}

export type ReviewFiles = NonNullable<Extract<LabEntry, { kind: "assistant" }>["fileChanges"]>;
export type FileReviewSelection = { files: ReviewFiles; path: string };

export function FileChangesCard({
  files,
  onReview,
}: {
  files: ReviewFiles;
  onReview?: ((selection: FileReviewSelection) => void) | undefined;
}) {
  const tree = useMemo(() => buildTurnDiffTree(files), [files]);
  const directories = useMemo(() => folderPaths(tree), [tree]);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [selected, select] = useState<string | null>(null);
  const allOpen = directories.every((path) => expanded.has(path));
  const folderAction = allOpen ? "Collapse all folders" : "Expand all folders";
  const diffAction = selected === null ? "Open diff" : "Back to files";
  const totals = files.reduce(
    (sum, f) => ({
      additions: sum.additions + f.additions,
      deletions: sum.deletions + f.deletions,
    }),
    { additions: 0, deletions: 0 },
  );
  function openReview(path: string | undefined) {
    if (path === undefined) return;
    if (onReview) onReview({ files, path });
    else select(path);
  }
  function toggle(path: string) {
    setExpanded((previous) => {
      const next = new Set(previous);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });
  }
  function rows(nodes: readonly TurnDiffTreeNode[], depth: number) {
    return nodes.map((node) => {
      const folder = node.kind === "directory";
      const open = folder && expanded.has(node.path);
      return (
        <li key={node.path}>
          <button
            type="button"
            className="m-change-row"
            style={{ paddingInlineStart: 9 + 12 * depth }}
            aria-expanded={folder ? open : undefined}
            onClick={() => (folder ? toggle(node.path) : openReview(node.path))}
          >
            {folder && <Icon size={12} name={open ? "chevron-down" : "chevron-right"} />}
            <Icon size={14} name={folder ? "folder" : "file-text"} />
            <span className="m-change-name">{node.name}</span>
            {node.stat && <FileChangeStats {...node.stat} />}
          </button>
          {node.kind === "directory" && open && <ul>{rows(node.children, depth + 1)}</ul>}
        </li>
      );
    });
  }
  return (
    <section className="m-changes-card" aria-label="Changed files">
      <div className="m-card-header m-changes-header">
        <strong>{files.length} changed files</strong>
        <FileChangeStats {...totals} />
        <span className="m-card-actions">
          {selected === null && (
            <button
              type="button"
              className="m-card-action m-change-all"
              aria-label={folderAction}
              // oxlint-disable-next-line t3code/no-native-title-tooltip -- lab-only icon action
              title={folderAction}
              data-collapse={allOpen}
              onClick={() => setExpanded(new Set(allOpen ? [] : directories))}
            />
          )}
          <button
            type="button"
            className="m-card-action"
            aria-label={diffAction}
            // oxlint-disable-next-line t3code/no-native-title-tooltip -- lab-only icon action
            title={diffAction}
            onClick={() => (selected === null ? openReview(files[0]?.path) : select(null))}
          >
            {selected === null ? (
              <span className="m-change-diff-icon" aria-hidden="true" />
            ) : (
              <Icon name="chevron-left" size={14} />
            )}
          </button>
        </span>
      </div>
      {selected === null ? (
        <ul className="m-change-tree">{rows(tree, 0)}</ul>
      ) : (
        <Suspense fallback={<p>Loading diff…</p>}>
          <FilePatch files={files} path={selected} />
        </Suspense>
      )}
    </section>
  );
}
