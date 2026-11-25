import Markdown, { type Components } from "react-markdown";
import remarkGfm from "remark-gfm";

import { CodeBlock } from "./CodeBlock";
import "./Markdown.css";

/** The markdown as plain lines, syntax dropped (apps/mobile markdownPreview.ts). */
export function markdownPreviewText(markdown: string) {
  const lines: string[] = [];
  let inFence = false;
  for (const raw of markdown.split(/\r?\n/)) {
    const line = raw.trimEnd();
    if (/^\s*(```|~~~)/.test(line)) {
      inFence = !inFence;
      continue;
    }
    if (line.trim() === "") continue;
    if (inFence) {
      lines.push(line);
      continue;
    }
    lines.push(
      line
        .replace(/^\s{0,3}#{1,6}\s+/, "")
        .replace(/^\s*[-*+]\s+/, "• ")
        .replace(/^\s*>\s?/, "")
        .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
        .replace(/\*\*(.+?)\*\*/g, "$1")
        .replace(/`([^`]*)`/g, "$1"),
    );
  }
  return lines.join("\n");
}

const MARKDOWN_COMPONENTS: Components = {
  pre: ({ node, children }) => {
    const code = node?.children[0];
    if (code?.type !== "element" || code.tagName !== "code") return <pre>{children}</pre>;
    const classes = code.properties.className;
    const fence = Array.isArray(classes)
      ? classes.find((c) => typeof c === "string" && c.startsWith("language-"))
      : undefined;
    const text = code.children.map((child) => (child.type === "text" ? child.value : "")).join("");
    return (
      <CodeBlock
        code={text.replace(/\n$/, "")}
        language={typeof fence === "string" ? fence.slice(9) : undefined}
      />
    );
  },
  code: ({ children }) => <code className="m-md-code">{children}</code>,
  table: ({ children }) => (
    <div className="m-table-scroll">
      <table>{children}</table>
    </div>
  ),
  img: ({ src, alt }) => (
    <img className="m-md-img" src={typeof src === "string" ? src : undefined} alt={alt ?? ""} />
  ),
};

export function MarkdownText(props: { readonly markdown: string; readonly muted?: boolean }) {
  return (
    <div className="m-md" data-muted={props.muted ? "true" : undefined}>
      <Markdown remarkPlugins={[remarkGfm]} components={MARKDOWN_COMPONENTS}>
        {props.markdown}
      </Markdown>
    </div>
  );
}
