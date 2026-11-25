import { useRef, useState } from "react";
import patches from "../data/filePatches.json";
import { Icon } from "./Icon";
import HighlightedCode from "./HighlightedCode";
import type { FileReviewSelection } from "./FileChangesCard";
import "./FilePatch.css";

type DiffRow =
  | { kind: "hunk" | "notice"; text: string }
  | { kind: "add" | "delete" | "context"; text: string; number: number };

function readRows(patch: string): DiffRow[] {
  const rows: DiffRow[] = [];
  let oldLine = 0;
  let newLine = 0;
  let inHunk = false;
  for (const line of patch.split("\n")) {
    const hunk = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(line);
    if (hunk) {
      oldLine = Number(hunk[1]);
      newLine = Number(hunk[2]);
      inHunk = true;
      rows.push({ kind: "hunk", text: line });
    } else if (inHunk) {
      const text = line.slice(1);
      if (line.startsWith("+")) rows.push({ kind: "add", text, number: newLine++ });
      else if (line.startsWith("-")) rows.push({ kind: "delete", text, number: oldLine++ });
      else if (line.startsWith(" ")) {
        oldLine++;
        rows.push({ kind: "context", text, number: newLine++ });
      } else if (line.startsWith("\\ ")) {
        rows.push({ kind: "notice", text: text.trimStart() });
      }
    }
  }
  return rows;
}

const languages: Readonly<Record<string, string>> = {
  rs: "rust",
  ts: "typescript",
  md: "markdown",
  json: "json",
  jsonl: "json",
  ndjson: "json",
};

const patchesByPath: Readonly<Record<string, string>> = patches;

function ReviewFile({ file }: { file: FileReviewSelection["files"][number] }) {
  const [collapsed, setCollapsed] = useState(false);
  const [viewed, setViewed] = useState(false);
  const rows = readRows(patchesByPath[file.path] ?? "");
  const language = languages[file.path.split(".").at(-1) ?? ""];
  return (
    <>
      <div className="m-review-file-header">
        <button
          type="button"
          className="m-review-file-toggle"
          aria-expanded={!collapsed}
          onClick={() => setCollapsed(!collapsed)}
        >
          <Icon name={collapsed ? "chevron-right" : "chevron-down"} size={16} />
          <Icon name="file-text" size={14} />
          <span className="m-review-file-path" dir="rtl">
            <bdi>{file.path}</bdi>
          </span>
        </button>
        <span className="m-review-file-counts">
          <span data-kind="delete">−{file.deletions}</span>
          <span data-kind="add">+{file.additions}</span>
        </span>
        <div className="m-review-viewed">
          <input
            type="checkbox"
            checked={viewed}
            onChange={(event) => setViewed(event.target.checked)}
            aria-label={`Mark ${file.path} as viewed`}
          />
          {viewed && <Icon name="check" size={12} />}
        </div>
      </div>
      {!collapsed && (
        <div className="m-review-code" tabIndex={0} aria-label={`Diff for ${file.path}`}>
          {rows.length === 0 && <div className="m-review-notice">No line changes</div>}
          {rows.map((row, index) => (
            // oxlint-disable-next-line react/no-array-index-key -- immutable rows of the fixture patch
            <div className="m-review-row" data-kind={row.kind} key={index}>
              <span className="m-review-gutter" aria-hidden="true">
                {"number" in row ? row.number : null}
              </span>
              {"number" in row ? (
                <code className="m-review-source">
                  {language ? <HighlightedCode language={language} code={row.text} /> : row.text}
                </code>
              ) : (
                <span className="m-review-source">{row.text}</span>
              )}
            </div>
          ))}
        </div>
      )}
    </>
  );
}

export default function FilePatch({ files, path }: FileReviewSelection) {
  const selected = useRef<HTMLElement>(null);
  return (
    <div
      className="m-review-scroll"
      ref={(scroll) => {
        // Anchor the review to the selected file without moving the chat scroll.
        if (scroll && selected.current) scroll.scrollTop = selected.current.offsetTop;
      }}
    >
      {files.map((file) => (
        <section key={file.path} ref={file.path === path ? selected : undefined}>
          <ReviewFile file={file} />
        </section>
      ))}
    </div>
  );
}
