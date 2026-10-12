import type { DiffsHighlighter } from "@pierre/diffs";
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";

import { useTheme } from "~/hooks/useTheme";
import { resolveDiffThemeName } from "~/lib/diffRendering";
import { getSyntaxHighlighterPromise } from "~/lib/syntaxHighlighting";

// Past this size the per-keystroke tokenizing is not worth it; show plain text.
const MAX_HIGHLIGHTED_CHARS = 20_000;

// Shiki font style bit flags.
const ITALIC = 1;
const BOLD = 2;
const UNDERLINE = 4;

type Tokens = ReturnType<DiffsHighlighter["codeToTokensBase"]>;

/**
 * The query editor. A transparent-text textarea sits over a `<pre>` that shows
 * the same text highlighted with the shared code highlighter and the theme that
 * file views and code blocks use. The textarea stays the real input; the
 * `<pre>` only mirrors its text, wrapping and scroll position. The SQL grammar
 * loads lazily, and the query shows as plain text until it is ready.
 */
export function SqlEditor({
  value,
  onChange,
  placeholder,
}: {
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
}) {
  const { resolvedTheme } = useTheme();
  const themeName = resolveDiffThemeName(resolvedTheme);
  const [highlighter, setHighlighter] = useState<DiffsHighlighter | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const overlayRef = useRef<HTMLPreElement>(null);

  useEffect(() => {
    let cancelled = false;
    getSyntaxHighlighterPromise("sql").then(
      (loaded) => {
        if (!cancelled) setHighlighter(loaded);
      },
      () => {},
    );
    return () => {
      cancelled = true;
    };
  }, []);

  const tokens = useMemo<Tokens | null>(() => {
    if (!highlighter || value.length > MAX_HIGHLIGHTED_CHARS) return null;
    try {
      return highlighter.codeToTokensBase(value, { lang: "sql", theme: themeName });
    } catch {
      return null;
    }
  }, [highlighter, value, themeName]);

  // Keep the overlay's content box and scroll position identical to the
  // textarea's, including when the textarea shows a scrollbar.
  const syncOverlay = useCallback(() => {
    const textarea = textareaRef.current;
    const overlay = overlayRef.current;
    if (!textarea || !overlay) return;
    overlay.style.width = `${textarea.clientWidth}px`;
    overlay.scrollTop = textarea.scrollTop;
    overlay.scrollLeft = textarea.scrollLeft;
  }, []);
  useLayoutEffect(syncOverlay);
  useEffect(() => {
    const textarea = textareaRef.current;
    if (!textarea || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(syncOverlay);
    observer.observe(textarea);
    return () => observer.disconnect();
  }, [syncOverlay]);

  return (
    <div className="relative flex max-h-[40%] min-h-24 shrink-0 flex-col border-b border-(--shell-divider)!">
      <pre
        ref={overlayRef}
        aria-hidden
        className="pointer-events-none absolute top-0 left-0 m-0 h-full overflow-hidden px-4 py-3 font-mono text-xs break-words whitespace-pre-wrap text-foreground"
      >
        {tokens
          ? tokens.map((line, lineIndex) => (
              // Lines have no identity beyond their position.
              // oxlint-disable-next-line react/no-array-index-key
              <span key={lineIndex}>
                {line.map((token, tokenIndex) => (
                  <span
                    // oxlint-disable-next-line react/no-array-index-key
                    key={tokenIndex}
                    style={{
                      color: token.color,
                      fontStyle: token.fontStyle && token.fontStyle & ITALIC ? "italic" : undefined,
                      fontWeight: token.fontStyle && token.fontStyle & BOLD ? "bold" : undefined,
                      textDecoration:
                        token.fontStyle && token.fontStyle & UNDERLINE ? "underline" : undefined,
                    }}
                  >
                    {token.content}
                  </span>
                ))}
                {lineIndex < tokens.length - 1 ? "\n" : null}
              </span>
            ))
          : value}
        {/* A trailing newline would otherwise collapse and misalign the last line. */}
        {"​"}
      </pre>
      <textarea
        ref={textareaRef}
        value={value}
        onChange={(event) => onChange(event.target.value)}
        onScroll={syncOverlay}
        placeholder={placeholder}
        aria-label="SQL query"
        spellCheck={false}
        rows={5}
        className="relative block min-h-24 min-w-0 w-full resize-y bg-transparent px-4 py-3 font-mono text-xs break-words whitespace-pre-wrap text-transparent caret-foreground outline-none selection:bg-foreground/15 placeholder:text-muted-foreground/70"
      />
    </div>
  );
}
