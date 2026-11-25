import { Fragment, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { copyFeedText } from "../../../lab-ios/src/components/copyFeedText";
import { Icon, Tool } from "./Icon";
import { definitionFor, fileSources, type FileLocation, type FileSelection } from "./filesFixture";
import "./FilesPanel.css";

export {
  walkthroughReveal,
  walkthroughStart,
  type FileLocation,
  type FileSelection,
} from "./filesFixture";

const paths = Object.keys(fileSources);
const folders = new Set(
  paths.flatMap((path) => {
    const parts = path.split("/");
    return parts.slice(1).map((_, i) => parts.slice(0, i + 1).join("/"));
  }),
);
const tree = [...folders, ...paths].sort((a, b) => a.localeCompare(b));
const initialFolders = [...folders].filter((path) => path !== "mock");

function fileLines(path: string) {
  return fileSources[path]!.replace(/\n$/, "").split("\n");
}

function treeParents(path: string) {
  const parts = path.split("/");
  return parts.slice(1).map((_, i) => parts.slice(0, i + 1).join("/"));
}

/** A text selection can start inside a syntax span. Measure offsets within its source line. */
function sourcePoint(node: Node, offset: number, editor: HTMLElement) {
  const element = node.nodeType === Node.TEXT_NODE ? node.parentElement : (node as Element);
  const line = element?.closest<HTMLElement>("[data-source-line]");
  if (!line || !editor.contains(line)) return undefined;
  const prefix = document.createRange();
  prefix.selectNodeContents(line);
  prefix.setEnd(node, offset);
  return { line: Number(line.dataset.sourceLine), column: prefix.toString().length };
}

function readSelection(path: string, lines: string[], editor: HTMLElement): FileSelection | null {
  const browserSelection = window.getSelection();
  if (!browserSelection?.rangeCount || browserSelection.isCollapsed) return null;
  const range = browserSelection.getRangeAt(0);
  const a = sourcePoint(range.startContainer, range.startOffset, editor);
  const b = sourcePoint(range.endContainer, range.endOffset, editor);
  if (!a || !b) return null;
  const excerpt = lines.slice(a.line - 1, b.line);
  excerpt[excerpt.length - 1] = excerpt.at(-1)!.slice(0, b.column);
  excerpt[0] = excerpt[0]!.slice(a.column);
  const text = excerpt.join("\n");
  if (!text) return null;
  return {
    path,
    start: a.line,
    end: b.column === 0 && b.line > a.line ? b.line - 1 : b.line,
    text,
  };
}

// Run the tokenizer once per opened fixture. Offset-preserving text nodes keep browser selections exact.
const syntax =
  /(?<comment>\/\/.*$|\/\*.*?\*\/)|(?<string>"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*')|(?<variable>\$[\w]+)|(?<keyword>\b(?:class|const|declare|else|extends|final|from|function|if|import|interface|let|namespace|new|private|public|readonly|return|type|use|export|false|null|true)\b)|(?<tag><\/?[\w-]+)|(?<type>\b[A-Z][\w]*\b)|(?<number>\b\d+(?:\.\d+)?\b)|(?<call>\b\w+(?=\())/g;
function tokensFor(line: string) {
  const tokens: { offset: number; text: string; kind?: string | undefined }[] = [];
  let end = 0;
  for (const token of line.matchAll(syntax)) {
    if (token.index > end) tokens.push({ offset: end, text: line.slice(end, token.index) });
    const kind = Object.keys(token.groups!).find((name) => token.groups![name] !== undefined);
    tokens.push({ offset: token.index, text: token[0], kind });
    end = token.index + token[0].length;
  }
  if (end < line.length) tokens.push({ offset: end, text: line.slice(end) });
  return tokens;
}

function FileBreadcrumb({ path, onBack }: { path: string; onBack: () => void }) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const parts = path.split("/");

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- Keep the filename visible on open and the edge fades aligned with the scrollable DOM region.
  useLayoutEffect(() => {
    const scroller = scrollRef.current;
    if (!scroller) return;
    let pinnedToEnd = true;
    const syncEdges = () => {
      const remaining = scroller.scrollWidth - scroller.clientWidth - scroller.scrollLeft;
      pinnedToEnd = remaining <= 1;
      scroller.toggleAttribute("data-fade-start", scroller.scrollLeft > 1);
      scroller.toggleAttribute("data-fade-end", !pinnedToEnd);
    };
    const onResize = () => {
      if (pinnedToEnd) scroller.scrollLeft = scroller.scrollWidth;
      syncEdges();
    };
    onResize();
    scroller.addEventListener("scroll", syncEdges, { passive: true });
    const observer = new ResizeObserver(onResize);
    observer.observe(scroller);
    observer.observe(scroller.firstElementChild!);
    return () => {
      observer.disconnect();
      scroller.removeEventListener("scroll", syncEdges);
    };
  }, []);

  return (
    <div className="lf-path-field">
      <Tool icon="chevron-left" label="Back to files" onClick={onBack} />
      <div
        className="lf-crumb"
        ref={scrollRef}
        role="region"
        aria-label={`File path: ${path}`}
        tabIndex={0}
        onKeyDown={(event) => {
          const scroller = event.currentTarget;
          if (event.key === "Home") scroller.scrollLeft = 0;
          else if (event.key === "End") scroller.scrollLeft = scroller.scrollWidth;
          else if (event.key === "ArrowLeft") scroller.scrollLeft -= 48;
          else if (event.key === "ArrowRight") scroller.scrollLeft += 48;
          else return;
          event.preventDefault();
        }}
      >
        <span className="lf-crumb-segments">
          {parts.map((part, i) => (
            <Fragment key={parts.slice(0, i + 1).join("/")}>
              {i > 0 && (
                <span aria-hidden="true" className="lf-crumb-separator">
                  <Icon name="chevron-right" />
                </span>
              )}
              {i === parts.length - 1 ? <strong>{part}</strong> : <span>{part}</span>}
            </Fragment>
          ))}
        </span>
      </div>
    </div>
  );
}

export function FilesPanel({
  onAddSelection,
  onNavigate,
  reveal,
}: {
  onAddSelection: (selection: FileSelection) => void;
  reveal?: FileLocation | undefined;
  onNavigate?: ((location: FileLocation | null) => void) | undefined;
}) {
  const [manualNavigation, setManualNavigation] = useState<{
    path: string | null;
    range: FileLocation | null;
    lastReveal: FileLocation | undefined;
  } | null>(null);
  // A new source link opens its location. Manual navigation takes over until the next reveal.
  const incoming = onNavigate || reveal !== manualNavigation?.lastReveal ? reveal : undefined;
  const path = incoming?.path ?? (onNavigate ? null : (manualNavigation?.path ?? null));
  const highlight = incoming ?? (onNavigate ? null : (manualNavigation?.range ?? null));
  const [tabs, setTabs] = useState<string[]>([]);
  if (path && !tabs.includes(path)) setTabs([...tabs, path]);
  const [query, setQuery] = useState("");
  const [expanded, setExpanded] = useState(initialFolders);
  const [wrap, setWrap] = useState(false);
  const [copyState, setCopyState] = useState<"idle" | "copied" | "error">("idle");
  const [selection, setSelection] = useState<FileSelection | null>(null);
  const editor = useRef<HTMLDivElement>(null);
  const anchor = useRef(1);
  const touch = useRef(false);
  const knownFile = !!path && Object.hasOwn(fileSources, path);
  const lines = useMemo(() => (path && knownFile ? fileLines(path) : []), [path, knownFile]);
  const code = useMemo(() => lines.map(tokensFor), [lines]);
  const selected = selection?.path === path ? selection : null;
  const matches = paths.filter((p) => p.toLowerCase().includes(query.trim().toLowerCase()));
  const matchingFolders = new Set(matches.flatMap(treeParents));
  const visible = tree.filter((p) => {
    if (query.trim()) return matches.includes(p) || matchingFolders.has(p);
    return treeParents(p).every((f) => expanded.includes(f));
  });

  function openFile(next: string | null, range: FileLocation | null = null) {
    if (onNavigate) onNavigate(range ?? (next ? { path: next, start: 1, end: 1 } : null));
    else setManualNavigation({ path: next, range, lastReveal: reveal });
    setCopyState("idle");
    if (!next && path) {
      setExpanded((existing) => [...new Set([...existing, ...treeParents(path)])]);
    }
    if (!range) {
      setSelection(null);
      anchor.current = 1;
    }
  }

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- Scroll the DOM viewport to the requested source range, keeping focus in the composer.
  useLayoutEffect(() => {
    const viewport = editor.current;
    if (!viewport) return;
    if (!highlight || highlight.path !== path) {
      viewport.scrollTop = 0;
      return;
    }
    const first = viewport.querySelector<HTMLElement>(`[data-row="${highlight.start}"]`);
    const last = viewport.querySelector<HTMLElement>(`[data-row="${highlight.end}"]`);
    if (!first || !last) return;
    const bounds = viewport.getBoundingClientRect();
    const top = first.getBoundingClientRect().top;
    if (top < bounds.top || last.getBoundingClientRect().bottom > bounds.bottom) {
      viewport.scrollTop += top - bounds.top - viewport.clientHeight / 3;
    }
  }, [path, highlight]);

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- Read browser text selections, including touch selection handles.
  useEffect(() => {
    function read() {
      if (!path || !editor.current) return;
      const current = readSelection(path, lines, editor.current);
      if (current) setSelection(current);
    }
    document.addEventListener("selectionchange", read);
    return () => document.removeEventListener("selectionchange", read);
  }, [path, lines]);

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- Clear the transient clipboard status and dispose its timer when the file closes.
  useEffect(() => {
    if (copyState === "idle") return;
    const timer = window.setTimeout(() => setCopyState("idle"), 1800);
    return () => clearTimeout(timer);
  }, [copyState]);

  function pickLines(line: number, extend: boolean) {
    if (!path) return;
    if (!extend || !selected) anchor.current = line;
    const start = Math.min(anchor.current, line);
    const end = Math.max(anchor.current, line);
    window.getSelection()?.removeAllRanges();
    setSelection({ path, start, end, text: lines.slice(start - 1, end).join("\n") });
  }

  return (
    <div className="lab-files" aria-label="Workspace files">
      {(tabs.length > 1 || (!path && tabs.length > 0)) && (
        <nav aria-label="Open files" className="lf-tabs">
          {tabs.map((tab) => (
            <div key={tab} className="lf-tab" data-active={tab === path}>
              <button
                type="button"
                aria-current={tab === path ? "page" : undefined}
                onClick={() => {
                  if (tab !== path) openFile(tab);
                }}
              >
                <Icon name="file-code" />
                {tab.split("/").at(-1)}
              </button>
              <Tool
                icon="close"
                label={`Close ${tab}`}
                onClick={() => {
                  const remaining = tabs.filter((t) => t !== tab);
                  setTabs(remaining);
                  if (path === tab) openFile(remaining.at(-1) ?? null);
                }}
              />
            </div>
          ))}
        </nav>
      )}
      {path === null ? (
        <>
          <div className="lf-toolbar lf-searchbar">
            <label className="lf-search">
              <Icon name="search" />
              <input
                aria-label="Search files"
                placeholder="Search files"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Escape") setQuery("");
                }}
              />
            </label>
            <div className="lf-tools">
              <Tool
                icon="refresh"
                label="Refresh workspace files"
                onClick={() => {
                  setQuery("");
                  setExpanded(initialFolders);
                }}
              />
              <Tool
                icon="chevrons-down-up"
                label="Expand or collapse folders"
                disabled={!!query.trim()}
                onClick={() => setExpanded(expanded.length === folders.size ? [] : [...folders])}
              />
            </div>
          </div>
          <div className="lf-tree">
            {visible.map((item) => {
              const directory = folders.has(item);
              const open = expanded.includes(item) || !!query.trim();
              const name = item.split("/").at(-1);
              return (
                <button
                  key={item}
                  type="button"
                  aria-expanded={directory ? open : undefined}
                  onClick={() => {
                    if (!directory) openFile(item);
                    else if (!query.trim())
                      setExpanded((prev) =>
                        open ? prev.filter((f) => f !== item) : [...prev, item],
                      );
                  }}
                >
                  <span
                    className="lf-caret"
                    style={{ marginInlineStart: treeParents(item).length * 14 }}
                  >
                    {directory && <Icon name={open ? "chevron-down" : "chevron-right"} />}
                  </span>
                  {directory ? null : (
                    <span className={item.endsWith(".php") ? "lf-php-icon" : "lf-ts-icon"}>
                      <Icon name="file-code" />
                    </span>
                  )}
                  {name}
                </button>
              );
            })}
            {!matches.length && <p className="lf-empty">No matching files.</p>}
          </div>
        </>
      ) : (
        <>
          <div className="lf-toolbar lf-filebar">
            <FileBreadcrumb key={path} path={path} onBack={() => openFile(null)} />
            {knownFile && (
              <div className="lf-tools">
                {selected && (
                  <Tool
                    icon="attach"
                    label="Add selection"
                    onMouseDown={(event) => event.preventDefault()}
                    onClick={() => onAddSelection(selected)}
                  />
                )}
                <Tool
                  icon="wrap-lines"
                  label="Wrap lines"
                  aria-pressed={wrap}
                  onClick={() => setWrap(!wrap)}
                />
                <Tool
                  icon={copyState === "copied" ? "check" : "copy"}
                  label={copyState === "copied" ? "Copied" : "Copy contents"}
                  onClick={async () =>
                    setCopyState((await copyFeedText(fileSources[path]!)) ? "copied" : "error")
                  }
                />
              </div>
            )}
          </div>
          {!knownFile && (
            <p className="lf-empty" role="status">
              This file is unavailable in the workspace preview.
            </p>
          )}
          {copyState === "error" && (
            <div role="status" className="lf-error">
              Clipboard unavailable. Select the code and copy it with your keyboard.
            </div>
          )}
          <div
            hidden={!knownFile}
            ref={editor}
            className="lf-editor"
            data-wrap={wrap}
            aria-label={path}
            tabIndex={0}
            onCopy={(event) => {
              if (!selected) return;
              event.clipboardData.setData("text/plain", selected.text);
              event.preventDefault();
            }}
            onKeyDown={(event) => {
              if (event.key === "Escape") {
                setSelection(null);
                window.getSelection()?.removeAllRanges();
              }
            }}
          >
            <div className="lf-lines">
              {code.map((tokens, i) => {
                const line = i + 1;
                const isSelected = !!selected && line >= selected.start && line <= selected.end;
                const revealed =
                  !!highlight &&
                  highlight.path === path &&
                  line >= highlight.start &&
                  line <= highlight.end;
                return (
                  <div
                    className="lf-line"
                    key={line}
                    data-row={line}
                    data-selected={isSelected}
                    data-revealed={revealed}
                  >
                    <button
                      type="button"
                      className="lf-number"
                      aria-label={`Select line ${line}`}
                      aria-pressed={isSelected}
                      aria-description="Shift-click or Shift-arrow to extend the selection"
                      data-line={line}
                      tabIndex={line === (selected?.end ?? 1) ? 0 : -1}
                      onClick={(event) => pickLines(line, event.shiftKey)}
                      onKeyDown={(event) => {
                        if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
                        event.preventDefault();
                        const next = Math.max(
                          1,
                          Math.min(lines.length, line + (event.key === "ArrowDown" ? 1 : -1)),
                        );
                        pickLines(next, event.shiftKey);
                        editor.current
                          ?.querySelector<HTMLButtonElement>(`[data-line="${next}"]`)
                          ?.focus();
                      }}
                    >
                      {line}
                    </button>
                    <code
                      className="lf-source"
                      data-source-line={line}
                      onPointerDown={() => setSelection(null)}
                    >
                      {tokens.map(({ text, offset, kind }) => {
                        const destination = definitionFor(path, text);
                        if (destination)
                          return (
                            <span
                              key={offset}
                              className="lf-symbol"
                              data-syntax={kind}
                              role="link"
                              tabIndex={0}
                              aria-label={`Go to definition of ${text.replaceAll("'", "")}`}
                              data-tip={`⌘-click for definition · ${destination.path}:${destination.start}`}
                              onPointerDown={(event) => {
                                touch.current =
                                  event.pointerType === "touch" || event.pointerType === "pen";
                              }}
                              onClick={(event) => {
                                if (
                                  event.metaKey ||
                                  event.ctrlKey ||
                                  event.detail === 0 ||
                                  (touch.current && window.getSelection()?.isCollapsed !== false)
                                )
                                  openFile(destination.path, destination);
                              }}
                              onKeyDown={(event) => {
                                if (event.key === "Enter") {
                                  event.preventDefault();
                                  openFile(destination.path, destination);
                                }
                              }}
                            >
                              {text}
                            </span>
                          );
                        return kind ? (
                          <span key={offset} data-syntax={kind}>
                            {text}
                          </span>
                        ) : (
                          <Fragment key={offset}>{text}</Fragment>
                        );
                      })}
                    </code>
                  </div>
                );
              })}
            </div>
          </div>
        </>
      )}
    </div>
  );
}
