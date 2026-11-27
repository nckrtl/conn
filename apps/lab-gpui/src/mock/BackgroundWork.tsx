// Timeline rows ported from GPUI: the finished background command card
// (`chat/background_command.rs`), the several-commands card (`chat/background_work.rs`), the
// info notice pill and the warning row (`render_notice_row`, `render_warning_row`), and a thread
// link chip (`markdown.rs`). Fixtures match `background_command_shots.rs`.
import { useState } from "react";
import { Icon } from "./Icon";
import "./BackgroundWork.css";

type Outcome = "Finished" | "Failed" | "Stopped";
interface CommandCard {
  id: string;
  label: string;
  outcome: Outcome;
  exitCode?: number;
  detail?: string;
}
interface WorkItem {
  id: string;
  kind: "command" | "monitor";
  label: string;
  exitCode?: number;
}
interface WorkCard {
  id: string;
  summary: string;
  outcome: Outcome;
  kind?: "command" | "monitor";
  items: WorkItem[];
}

const LONG_COMMAND =
  "L=~/apps/conn-gpui-dev/apps/conn-gpui/.t3/dev-hot.log; N=$(( $(wc -l < $L) + 1 )); until tail -n +$N $L | grep -q 'build finished'; do sleep 2; done";
const verb = { Finished: "finished", Failed: "failed", Stopped: "was stopped" } as const;
const summaryOf = (card: CommandCard) =>
  `Command "${card.label}" ${verb[card.outcome]}${card.exitCode === undefined ? "" : ` (exit ${card.exitCode})`}`;

const singles: CommandCard[] = [
  { id: "bg-long", label: LONG_COMMAND.slice(0, 73) + "…", outcome: "Finished" },
  {
    id: "bg-ok",
    label: "Wait for dev app rebuild",
    outcome: "Finished",
    exitCode: 0,
    detail: "build finished in 41s\n12 crates compiled, 0 warnings",
  },
  {
    id: "bg-fail",
    label: "npm test",
    outcome: "Failed",
    exitCode: 2,
    detail: "1 failing\n  1) adds numbers: expected 3, got 4",
  },
  { id: "bg-stopped", label: "sleep 600", outcome: "Stopped" },
];
const BUILD = "Build baseline server with fake provider";
const CHECK = "Run server tools/check.sh";
const several: WorkCard[] = [
  {
    id: "bg-three",
    summary: `Command "${BUILD}", command "${BUILD}" and command "${CHECK}" failed`,
    outcome: "Failed",
    kind: "command",
    items: [
      { id: "item-1", kind: "command", label: BUILD },
      { id: "item-2", kind: "command", label: BUILD },
      { id: "item-3", kind: "command", label: CHECK },
    ],
  },
  {
    id: "bg-two",
    summary: 'Command "make" (exit 0) and command "npm test" (exit 2) failed',
    outcome: "Failed",
    kind: "command",
    items: [
      { id: "item-4", kind: "command", label: "make", exitCode: 0 },
      { id: "item-5", kind: "command", label: "npm test", exitCode: 2 },
    ],
  },
  {
    id: "bg-mixed",
    summary: 'Command "cargo build --release" and monitor "CI checks" finished',
    outcome: "Finished",
    items: [
      { id: "item-6", kind: "command", label: "cargo build --release" },
      { id: "item-7", kind: "monitor", label: "CI checks" },
    ],
  },
];

/** A capitalised sentence without shell syntax is a description; anything else is a command. */
function isCommandText(label: string) {
  const text = label.trim();
  const sentence =
    /^\p{Lu}/u.test(text) && text.split(/\s+/).length > 1 && !/[$|;&<>()=~/\\"'`*{}[\]]/.test(text);
  return !sentence;
}
const statusText = (outcome: Outcome, exitCode?: number) =>
  exitCode === undefined ? outcome : `${outcome} · exit ${exitCode}`;

function Caret({ expanded }: { expanded: boolean }) {
  return (
    <span className="bg-caret">
      <Icon name={expanded ? "chevron-down" : "chevron-right"} />
    </span>
  );
}

function BackgroundCommand({ card, open }: { card: CommandCard; open: boolean }) {
  const [expanded, setExpanded] = useState(open);
  const failed = card.outcome === "Failed";
  const body = [summaryOf(card), card.detail].filter(Boolean).join("\n\n");
  return (
    <div className="bg-card" data-failed={failed || undefined}>
      <button
        type="button"
        className="bg-line"
        aria-expanded={expanded}
        aria-label={`Background command: ${card.label} (${statusText(card.outcome, card.exitCode).replace(" · ", ", ")})`}
        onClick={() => setExpanded(!expanded)}
      >
        <Icon name={failed ? "error-circle" : "terminal"} />
        <span className="bg-label" data-mono={isCommandText(card.label) || undefined}>
          {card.label}
        </span>
        <span className="bg-status">{statusText(card.outcome, card.exitCode)}</span>
        <Caret expanded={expanded} />
      </button>
      {expanded && <pre className="bg-detail">{body}</pre>}
    </div>
  );
}

function BackgroundWork({ card, open }: { card: WorkCard; open: boolean }) {
  const [expanded, setExpanded] = useState(open);
  const failed = card.outcome === "Failed";
  const noun = card.kind ? card.kind + "s" : "background tasks";
  return (
    <div className="bg-card bg-work" data-failed={failed || undefined}>
      <button
        type="button"
        className="bg-line"
        aria-expanded={expanded}
        aria-label={`Background work: ${card.items.length} ${noun} (${card.outcome})`}
        onClick={() => setExpanded(!expanded)}
      >
        <Icon
          name={
            failed
              ? "error-circle"
              : card.kind === "command"
                ? "terminal"
                : card.kind === "monitor"
                  ? "show"
                  : "tool"
          }
        />
        <span className="bg-label bg-count">
          {card.items.length} {noun}
        </span>
        <span className="bg-status">{card.outcome}</span>
        <Caret expanded={expanded} />
      </button>
      {card.items.map((item) => (
        <div key={item.id} className="bg-item">
          <Icon name={item.kind === "monitor" ? "show" : "terminal"} />
          <span className="bg-label" data-mono={isCommandText(item.label) || undefined}>
            {item.label}
          </span>
          {item.exitCode !== undefined && (
            <span className="bg-status" data-bad={item.exitCode !== 0 || undefined}>
              exit {item.exitCode}
            </span>
          )}
        </div>
      ))}
      {expanded && <pre className="bg-detail">{card.summary}</pre>}
    </div>
  );
}

export function NoticePill({ text }: { text: string }) {
  return (
    <div className="notice-pill" role="group" aria-label={"Notice: " + text}>
      <span>
        <Icon name={/compact/i.test(text) ? "minimize" : "info"} />
        {text}
      </span>
    </div>
  );
}

export function WarningRow({ text }: { text: string }) {
  const [expanded, setExpanded] = useState(false);
  return (
    <div className="warning-notice">
      <button
        type="button"
        className="warning-row"
        aria-expanded={expanded}
        aria-label={"Warning: " + text}
        onClick={() => setExpanded(!expanded)}
      >
        <Icon name="error-circle" />
        <span>{text.split(/\s+/).join(" ")}</span>
        <Caret expanded={expanded} />
      </button>
      {expanded && <p className="warning-detail">{text}</p>}
    </div>
  );
}

/**
 * `?work=single` (default) shows the four single-command cards, `multi` the several-commands
 * cards, `pills` the old info pills and `notices` the warning rows and a thread link chip.
 * `?expanded=1` opens the cards GPUI's `*-expanded` shots open.
 */
export function BackgroundWorkFeed() {
  const params = new URLSearchParams(location.search);
  const work = params.get("work") ?? "single";
  const open = params.get("expanded") === "1";
  if (work === "multi")
    return several.map((card) => (
      <BackgroundWork key={card.id} card={card} open={open && card.id === "bg-three"} />
    ));
  if (work === "pills")
    return [...singles.map(summaryOf), ...several.map((card) => card.summary)].map((text) => (
      <NoticePill key={text} text={text} />
    ));
  if (work === "notices")
    return (
      <>
        <WarningRow text="MCP server orbit failed to start: connection refused (os error 61). Check the server command in Settings > MCP." />
        <WarningRow text="MCP server figma needs authentication before its tools can be used." />
        <NoticePill text="Context compacted" />
        <p className="assistant-reply">
          I filed the follow-up as{" "}
          <a className="thread-chip" href="#/environment-render/storage">
            Set up executor v2 + Orbit MCP
          </a>{" "}
          and linked it from this thread.
        </p>
      </>
    );
  return singles.map((card) => (
    <BackgroundCommand
      key={card.id}
      card={card}
      open={open && (card.id === "bg-ok" || card.id === "bg-fail")}
    />
  ));
}
