import { lazy, Suspense, useState } from "react";
import { Icon } from "./Icon";
import { ComposerPanelDeck } from "./ComposerPanelDeck";
import "./CodeBlock.css";
import "./ComposerApprovalCard.css";

const HighlightedCode = lazy(() => import("./HighlightedCode"));

const options = {
  command: [
    { label: "Cancel", decision: "cancel" },
    { label: "Decline", decision: "decline" },
    { label: "Approve", decision: "accept" },
  ],
  session: [
    { label: "Allow once", decision: "accept" },
    { label: "Allow session", decision: "acceptForSession" },
    { label: "Decline", decision: "decline" },
  ],
} as const;

export type ApprovalExample = keyof typeof options | "long" | "two" | "six";
type Decision = (typeof options)[keyof typeof options][number]["decision"];

const commands = [
  "rm -rf build",
  "bun run build",
  "bun run typecheck",
  "bun run lint",
  "bun test apps/lab-ios",
  "git diff --check",
];

const queues = {
  command: commands.slice(0, 1),
  session: commands.slice(0, 1),
  long: [
    [
      "export BUILD_MODE='production' &&",
      "  bun run --filter '@t3tools/lab-ios' build &&",
      "  git diff --check -- 'apps/lab-ios/src'",
    ].join("\n"),
  ],
  two: commands.slice(0, 2),
  six: commands,
} satisfies Record<ApprovalExample, readonly string[]>;

const results: Record<Decision, string> = {
  cancel: "Approval canceled",
  decline: "Approval declined",
  accept: "Approved once",
  acceptForSession: "Approved for this session",
};

export function ComposerApprovalCard({
  example,
  queuedAfter = 0,
  onComplete,
}: {
  example: ApprovalExample;
  queuedAfter?: number;
  onComplete?: (result: string) => void;
}) {
  const [progress, setProgress] = useState({ index: 0, result: "" });
  const queue = queues[example];
  const remaining = queue.length - progress.index;
  const command = queue[progress.index];
  if (command === undefined)
    return (
      <p className="m-composer-approval-result" role="status">
        {progress.result}
      </p>
    );
  return (
    <ComposerPanelDeck remaining={remaining + queuedAfter} kind="approval">
      <section className="m-composer-panel m-composer-approval" aria-label="Approval needed">
        <div className="m-composer-panel-header">
          <Icon name="needs-approval" size={14} />
          <span>Approval needed</span>
          <span className="m-composer-approval-kind" role="img" aria-label="Terminal command">
            <Icon name="terminal" size={16} />
          </span>
          {queue.length > 1 && <span role="status">{remaining} pending</span>}
        </div>
        <div className="m-composer-panel-body m-composer-approval-code">
          <div className="m-composer-panel-scroll m-scroll" key={progress.index}>
            <pre className="m-code-body m-composer-approval-detail" data-wrap="true">
              <code>
                <Suspense fallback={command}>
                  <HighlightedCode code={command} language="bash" />
                </Suspense>
              </code>
            </pre>
          </div>
        </div>
        <div className="m-composer-panel-actions m-composer-decision-actions">
          {options[example === "session" ? "session" : "command"].map(({ label, decision }) => (
            <button
              key={decision}
              type="button"
              className={decision === "cancel" ? "m-composer-text-action" : undefined}
              data-decision={decision}
              onClick={() => {
                const result = results[decision];
                if (remaining === 1 && onComplete) onComplete(result);
                else setProgress({ index: progress.index + 1, result });
              }}
            >
              {label}
            </button>
          ))}
        </div>
      </section>
    </ComposerPanelDeck>
  );
}
