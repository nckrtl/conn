import { copyFeedText } from "./copyFeedText";
import { lazy, Suspense, useState } from "react";
import { Icon } from "./Icon";
import "./CardHeader.css";
import "./CodeBlock.css";

const HighlightedCode = lazy(() => import("./HighlightedCode"));

// Match the language names used by the native mobile code header.
const FENCE_DISPLAY_NAMES: Readonly<Record<string, string>> = {
  css: "CSS",
  html: "HTML",
  js: "JavaScript",
  json: "JSON",
  jsx: "JSX",
  md: "Markdown",
  py: "Python",
  rs: "Rust",
  sh: "Shell",
  ts: "TypeScript",
  tsx: "TSX",
  typescript: "TypeScript",
  javascript: "JavaScript",
  yaml: "YAML",
  yml: "YAML",
  cc: "C++",
  cpp: "C++",
  cxx: "C++",
  cs: "C#",
  csharp: "C#",
  graphql: "GraphQL",
  objc: "Objective-C",
  objectivec: "Objective-C",
  php: "PHP",
  rb: "Ruby",
  scss: "SCSS",
  sql: "SQL",
  toml: "TOML",
  xml: "XML",
};

export function CodeBlock({
  code,
  language,
  title,
}: {
  code: string;
  language?: string | undefined;
  title?: string;
}) {
  const [wrap, setWrap] = useState(false);
  const [copied, setCopied] = useState(false);
  const lang = language?.toLowerCase();
  const plain = !lang || ["text", "txt", "plain", "plaintext"].includes(lang);
  const languageLabel = plain
    ? "Text"
    : Object.hasOwn(FENCE_DISPLAY_NAMES, lang)
      ? FENCE_DISPLAY_NAMES[lang]
      : lang.charAt(0).toUpperCase() + lang.slice(1);
  const label = title ?? languageLabel;
  async function copy() {
    if (await copyFeedText(code)) {
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1200);
    }
  }
  return (
    <div
      className="m-code"
      role="group"
      aria-label={plain && title === undefined ? "Code block" : `Code block (${label})`}
    >
      <div className="m-card-header m-code-header">
        <span className="m-code-label" data-lang={lang}>
          {label}
        </span>
        <span className="m-card-actions">
          <button
            className="m-card-action"
            aria-label="Toggle word wrap"
            aria-pressed={wrap}
            onClick={() => setWrap(!wrap)}
          >
            <Icon name="wrap-lines" size={12} />
          </button>
          <button
            className="m-card-action"
            aria-label={copied ? "Code copied" : "Copy code"}
            onClick={copy}
          >
            <Icon name={copied ? "check" : "copy"} size={12} />
          </button>
        </span>
      </div>
      <pre className="m-code-body" data-wrap={wrap}>
        <code>
          {plain ? (
            code
          ) : (
            <Suspense fallback={code}>
              <HighlightedCode language={lang} code={code} />
            </Suspense>
          )}
        </code>
      </pre>
    </div>
  );
}
