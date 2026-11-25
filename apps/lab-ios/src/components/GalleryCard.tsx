import { useState, type ReactElement, type ReactNode } from "react";
import type { AdditionalThreadCard } from "../data/fixtures";
import demoVideo from "../data/thread-demo.mp4?url";
import handoffImage from "../../../lab-gpui/image-preview/handoff.webp";
import type { IconName } from "../icons.generated";
import { CodeBlock } from "./CodeBlock";
import { Icon } from "./Icon";
import { MarkdownText } from "./Markdown";
import { copyFeedText } from "./copyFeedText";
import "./GalleryCard.css";

const plan = [
  "1. Confirm which stalled pull requests already passed CI.",
  "2. Assign each remaining review to its owner.",
  "3. Verify the thread list after the reviews land.",
].join("\n");
const notes =
  "Orbit review notes\n\nWorkers PR #4812 is ready for review.\nIngress still needs an owner.\n";
const releaseChecklist = "# Release checklist\n\n- [ ] Run checks\n- [ ] Request review\n";
const reviewNotes = { name: "review-notes.txt", size: `${notes.length} B`, href: textUrl(notes) };
const mixedAttachments = [
  { name: "release-notes.docx", size: "42 KB" },
  { name: "review-tracker.xlsx", size: "86 KB" },
  { name: "rollout-summary.pdf", size: "318 KB" },
  { name: "handoff.md", size: "4 KB" },
  { name: "review-assets.zip", size: "2.4 MB" },
];
function embeddedPage(title: string, content: string, css: string) {
  return `<!doctype html><html lang="en"><meta charset="utf-8"><title>${title}</title>
  <style>
    :root { color-scheme: light dark; }
    body { margin: 0; padding: 10px 11px; font: 13px/1.5 system-ui; color: CanvasText; }
    h1 { margin: 0 0 8px; font-size: 13px; font-weight: 500; }
    ${css}
  </style>
  <h1>${title}</h1>
  ${content}
</html>`;
}

const htmlPreview = embeddedPage(
  "Orbit review summary",
  "<dl><dt>Ready for review</dt><dd>2</dd><dt>Needs an owner</dt><dd>1</dd><dt>Already merged</dt><dd>1</dd></dl>",
  `
    dl { display: grid; grid-template-columns: 1fr auto; gap: 8px 12px; margin: 0; }
    dd { margin: 0; }
  `,
);

const mcpPreview = embeddedPage(
  "Orbit review queue",
  `
    <div class="filters" role="group" aria-label="Filter pull requests">
      <input type="radio" id="all" name="status" checked>
      <label for="all">All</label>
      <input type="radio" id="review" name="status">
      <label for="review">Needs review</label>
    </div>
    <ul>
      <li>Workers #4812 <span>Needs review</span></li>
      <li class="merged">Delivery speed #4811 <span>Merged</span></li>
    </ul>
  `,
  `
    .filters { display: flex; gap: 6px; }
    .filters input { position: absolute; width: 1px; height: 1px; opacity: 0; }
    .filters label { padding: 5px 10px; border: 1px solid transparent; border-radius: 8px;
      background: color-mix(in srgb, Canvas 50%, transparent); cursor: pointer; }
    .filters input:checked + label { border-color: GrayText; }
    .filters input:focus-visible + label { outline: 2px solid Highlight; outline-offset: 2px; }
    ul { display: grid; gap: 5px; margin: 8px 0 0; padding: 0; list-style: none; }
    li { display: flex; justify-content: space-between; gap: 8px; }
    li span { color: color-mix(in srgb, CanvasText 60%, transparent); }
    .filters:has(#review:checked) + ul .merged { display: none; }
  `,
);

function textUrl(text: string) {
  return `data:text/plain;charset=utf-8,${encodeURIComponent(text)}`;
}

function ExampleCard({
  label,
  icon,
  title,
  action,
  children,
}: {
  label: string;
  icon: IconName | ReactElement;
  title?: string;
  action?: ReactNode;
  children: ReactNode;
}) {
  return (
    <section className="m-gallery-card" aria-label={label}>
      <div className="m-card-header m-gallery-card-header">
        {typeof icon === "string" ? <Icon name={icon} size={14} /> : icon}
        <span>{label}</span>
        {action && <div className="m-card-actions">{action}</div>}
      </div>
      <div className="m-gallery-card-body">
        {title && <div className="m-feed-card-title">{title}</div>}
        {children}
      </div>
    </section>
  );
}

function PlanExample() {
  const [copied, setCopied] = useState(false);
  const contents = `# Review the stalled Orbit pull requests\n\n${plan}\n`;
  return (
    <ExampleCard
      label="Proposed plan"
      icon="checklist"
      title="Review the stalled Orbit pull requests"
      action={
        <>
          <button
            type="button"
            className="m-card-action"
            aria-label={copied ? "Plan copied" : "Copy plan"}
            onClick={async () => setCopied(await copyFeedText(contents))}
          >
            <Icon name={copied ? "check" : "copy"} size={14} />
          </button>
          <a
            className="m-card-action"
            href={textUrl(contents)}
            download="plan.md"
            aria-label="Download plan"
          >
            <Icon name="download" size={14} />
          </a>
        </>
      }
    >
      <MarkdownText markdown={plan} />
    </ExampleCard>
  );
}

function SecretRequestExample() {
  const [result, setResult] = useState<string | null>(null);
  const [answer, setAnswer] = useState("");

  return (
    <ExampleCard
      label="Secret request"
      icon="pin"
      title="Review service token"
      action={
        !result && (
          <>
            <button
              type="button"
              className="m-gallery-header-link"
              data-tone="danger"
              onClick={() => setResult("Declined")}
            >
              Decline
            </button>
            <button
              type="button"
              className="m-gallery-header-link m-gallery-header-save"
              disabled={!answer.trim()}
              onClick={() => setResult("Demo token saved")}
            >
              Save
            </button>
          </>
        )
      }
    >
      <p>Enter sample-token to preview how a secret request is answered.</p>
      {result ? (
        <p className="m-gallery-result" role="status">
          <Icon name="check" size={14} />
          {result}
        </p>
      ) : (
        <input
          type="password"
          aria-label="Demo token"
          autoComplete="off"
          value={answer}
          onChange={(event) => setAnswer(event.target.value)}
        />
      )}
    </ExampleCard>
  );
}

function WorktreeExample({ status }: { status: "running" | "ready" | "failed" }) {
  const running = status === "running";
  const failed = status === "failed";
  const creationSeconds = 1;
  const scriptSeconds = failed ? 3 : 4;
  const resultIcon = failed ? "close" : "check";
  return (
    <ExampleCard
      label="Worktree setup"
      icon="branch"
      action={
        running ? (
          <span
            className="m-worktree-status m-worktree-progress"
            role="progressbar"
            aria-label="Worktree setup"
            aria-valuemin={0}
            aria-valuemax={2}
            aria-valuenow={1}
            aria-valuetext="1 of 2 steps complete"
          />
        ) : (
          <>
            <span
              className="m-worktree-status"
              role="img"
              aria-label={failed ? "Worktree setup failed" : "Worktree ready"}
            >
              <Icon name={resultIcon} size={16} />
            </span>
            <span className="m-worktree-total">{creationSeconds + scriptSeconds}s</span>
          </>
        )
      }
    >
      <ul className="m-gallery-list">
        <li>
          <Icon name="check" size={14} /> Created worktree <span>{creationSeconds}s</span>
        </li>
        <li>
          {running ? (
            <span className="m-worktree-progress m-worktree-step-progress" aria-hidden="true" />
          ) : (
            <Icon name={resultIcon} size={14} />
          )}
          {running ? "Running setup script" : failed ? "Setup script failed" : "Ran setup script"}
          {!running && <span>{scriptSeconds}s</span>}
        </li>
      </ul>
    </ExampleCard>
  );
}

interface FileAttachment {
  name: string;
  size: string;
  href?: string;
}

function FileAttachmentRow({ name, size, href }: FileAttachment) {
  const content = (
    <>
      <span
        className="m-gallery-file-icon"
        data-extension={name.split(".").at(-1)}
        aria-hidden="true"
      />
      <strong>{name}</strong>
      <small>{size}</small>
    </>
  );
  return href ? (
    <a className="m-gallery-attachment" href={href} download={name}>
      {content}
    </a>
  ) : (
    <div className="m-gallery-attachment">{content}</div>
  );
}

function FileAttachmentMessage({
  files,
  message,
}: {
  files: readonly FileAttachment[];
  message?: string;
}) {
  return (
    <div className="m-user" role="group" aria-label="Sent message with attachments">
      <div className="m-user-bubble m-gallery-attachment-bubble m-gallery-inset-message">
        {message && <span>{message}</span>}
        <div className="m-gallery-file-list">
          {files.map((file) => (
            <FileAttachmentRow key={file.name} {...file} />
          ))}
        </div>
      </div>
    </div>
  );
}

export function GalleryCard({ card }: { card: AdditionalThreadCard }) {
  switch (card) {
    case "plan":
      return <PlanExample />;
    case "secret":
      return <SecretRequestExample />;
    case "worktree":
      return <WorktreeExample status="ready" />;
    case "worktreeRunning":
      return <WorktreeExample status="running" />;
    case "worktreeFailed":
      return <WorktreeExample status="failed" />;
    case "reviewComment":
      return (
        <div className="m-user" aria-label="Your review comment">
          <div className="m-user-bubble m-gallery-attachment-bubble m-gallery-inset-message">
            <span>Could we keep the workspace check next to the selection logic?</span>
            <CodeBlock
              title="app.rs · #3718"
              language="diff"
              code={"- if selected.is_some() {\n+ if self.active_workspace.is_some() {"}
            />
          </div>
        </div>
      );
    case "template":
      return (
        <ExampleCard
          label="Artifact template"
          icon="file-text"
          action={
            <a
              className="m-card-action"
              href={textUrl(releaseChecklist)}
              download="release-checklist.md"
              aria-label="Download release checklist"
            >
              <Icon name="download" size={14} />
            </a>
          }
        >
          <div className="m-gallery-template-file">
            <span className="m-feed-card-title">Release checklist</span>
            <small>{new TextEncoder().encode(releaseChecklist).length} B</small>
          </div>
        </ExampleCard>
      );
    case "html":
      return (
        <ExampleCard label="HTML preview" icon="laptop">
          <iframe
            className="m-gallery-embed"
            title="Orbit review summary"
            height={126}
            srcDoc={htmlPreview}
            sandbox=""
          />
        </ExampleCard>
      );
    case "mcp":
      return (
        <ExampleCard
          label="MCP app"
          icon={<span className="m-gallery-mcp-icon" aria-hidden="true" />}
        >
          <iframe
            className="m-gallery-embed"
            title="Orbit review queue"
            height={132}
            srcDoc={mcpPreview}
            sandbox=""
          />
        </ExampleCard>
      );
    case "file":
      return <FileAttachmentMessage files={[reviewNotes]} />;
    case "mixedFiles":
      return <FileAttachmentMessage files={mixedAttachments} />;
    case "fileWithText":
      return (
        <FileAttachmentMessage files={[reviewNotes]} message="Here are my notes from the review." />
      );
    case "mixedFilesWithText":
      return (
        <FileAttachmentMessage
          files={mixedAttachments.slice(0, 3)}
          message="Here are the release notes, the tracker, and the rollout summary."
        />
      );
    case "video":
      return (
        <div className="m-user">
          <div className="m-user-bubble m-gallery-attachment-bubble m-gallery-video-bubble">
            <video
              className="m-gallery-video"
              aria-label="Silent preview of the provider handoff"
              controls
              playsInline
              preload="none"
              poster={handoffImage}
              src={demoVideo}
            />
          </div>
        </div>
      );
  }
}
