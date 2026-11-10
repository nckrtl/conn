import type { ApplicationLogUpdate } from "../applicationLogs";
import { DependenciesPanel, useOrbitDependencies } from "./dependencies";
import { ArrowDownToLine, Copy, Play, RotateCw, Square } from "lucide-react";
import { type ReactNode, type SVGProps, useEffect, useRef, useState } from "react";

import { Button } from "~/components/ui/button";
import { ToolbarGroup } from "~/components/ToolbarGroup";
import { ScrollArea } from "~/components/ui/scroll-area";
import { Tooltip, TooltipPopup, TooltipTrigger } from "~/components/ui/tooltip";
import { cn } from "~/lib/utils";

import { useOrbitTool } from "../context";
import { formatBytes } from "../model";
import {
  type OrbitProcess,
  parseLogLines,
  type ProcessAction,
  type ProcessStatus,
  splitLogLevels,
} from "../orbit";
import {
  EmptyRow,
  KeyValueRows,
  PanelShell,
  secondaryLineClass,
  Stat,
  StatStrip,
  UnderlineTabs,
} from "./parts";

const LOG_LINES = 200;
const PROCESS_REFRESH_MS = 5_000;
const LOG_REFRESH_MS = 3_000;

/** Orbit's mark, as in the Laravel toolbar's Orbit tool. */
export function OrbitIcon(props: SVGProps<SVGSVGElement>) {
  return (
    <svg viewBox="0 0 100 100" fill="none" aria-hidden="true" {...props}>
      <path
        d="M50 25C77.6143 25 100 36.1929 100 50C99.9996 63.8069 77.614 75 50 75C22.386 75 0.000366987 63.8069 0 50C0 36.1929 22.3858 25 50 25ZM49.7764 32.0107C32.7857 32.0108 15.7344 38.9923 15.7344 46.9102C15.7346 54.8279 28.3485 61.2461 49.5654 61.2461C70.7823 61.2461 83.3962 54.8279 83.3965 46.9102C83.3965 38.9923 66.7672 32.0107 49.7764 32.0107Z"
        fill="currentColor"
      />
    </svg>
  );
}

const STATUS_MARKER = {
  running: "bg-success",
  starting: "bg-info",
  crashed: "bg-destructive",
  stopped: "bg-muted-foreground/50",
} as const;

function IconAction({
  label,
  disabled = false,
  onClick,
  children,
}: {
  label: string;
  disabled?: boolean;
  onClick: () => void;
  children: ReactNode;
}) {
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <Button
            variant="ghost"
            size="icon-xs"
            type="button"
            aria-label={label}
            disabled={disabled}
            onClick={(event) => {
              event.stopPropagation();
              onClick();
            }}
          />
        }
      >
        {children}
      </TooltipTrigger>
      <TooltipPopup side="top">{label}</TooltipPopup>
    </Tooltip>
  );
}

function ProcessItem({
  process,
  selected,
  busy,
  onSelect,
  onAct,
}: {
  process: OrbitProcess;
  selected: boolean;
  busy: boolean;
  onSelect: () => void;
  onAct: (action: ProcessAction) => void;
}) {
  const up = process.status === "running" || process.status === "starting";
  const usage = [
    process.cpu === null ? null : `${process.cpu.toFixed(1)}% CPU`,
    process.memoryBytes === null ? null : formatBytes(process.memoryBytes),
  ].filter(Boolean);
  return (
    <div
      className={cn(
        "flex cursor-pointer items-center gap-2 border-b py-2.5 pr-1.5 pl-3 text-xs hover:bg-foreground/4",
        selected && "bg-accent hover:bg-accent",
      )}
      onClick={onSelect}
    >
      <span className={cn("h-8 w-0.5 shrink-0 rounded-full", STATUS_MARKER[process.status])} />
      <div className="min-w-0 flex-1">
        <div className="truncate font-mono">{process.name}</div>
        <div className={cn("truncate tabular-nums", secondaryLineClass)}>
          {process.status === "running" && usage.length > 0 ? usage.join(" · ") : process.status}
        </div>
      </div>
      <div className="flex shrink-0 items-center">
        {up ? (
          <IconAction label={`Stop ${process.name}`} disabled={busy} onClick={() => onAct("stop")}>
            <Square />
          </IconAction>
        ) : (
          <IconAction
            label={`Start ${process.name}`}
            disabled={busy}
            onClick={() => onAct("start")}
          >
            <Play />
          </IconAction>
        )}
        <IconAction
          label={`Restart ${process.name}`}
          disabled={busy || !up}
          onClick={() => onAct("restart")}
        >
          <RotateCw />
        </IconAction>
      </div>
    </div>
  );
}

const LEVEL_CLASS: Record<string, string> = {
  INFO: "text-info-foreground",
  WARN: "text-warning-foreground",
  WARNING: "text-warning-foreground",
  ERROR: "text-destructive",
  FAIL: "text-destructive",
  FAILED: "text-destructive",
  DONE: "text-success-foreground",
  RUNNING: "text-muted-foreground",
};

/** One log line: muted time, colored level words, the rest as written. */
function LogLineRow({ time, text }: { time: string | null; text: string }) {
  return (
    <div className="flex gap-3 px-3 py-0.5 hover:bg-foreground/4">
      {time ? <span className="shrink-0 text-muted-foreground">{time}</span> : null}
      <span className="min-w-0 whitespace-pre-wrap break-all">
        {splitLogLevels(text).map(({ offset, text: part, level }) => (
          <span key={offset} className={level ? LEVEL_CLASS[level] : undefined}>
            {part}
          </span>
        ))}
      </span>
    </div>
  );
}

/**
 * The selected process's log tail. Read again when its status changes (a crash leaves
 * its reason in the log) and every few seconds while following.
 */
function useProcessLog(processId: number | null, status: ProcessStatus | null, following: boolean) {
  const { source } = useOrbitTool();
  const [log, setLog] = useState<{ processId: number; text: string } | null>(null);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- polls the process log from Orbit on a timer
  useEffect(() => {
    if (!source || processId === null) return;
    let cancelled = false;
    let timer: number | null = null;
    const read = async () => {
      try {
        const text = await source.logs(processId, LOG_LINES);
        if (!cancelled) setLog({ processId, text });
      } catch {
        // Keep the last tail; the next read may succeed.
      }
      // A starting process changes fast; check it more often until it settles.
      if (!cancelled && following) {
        timer = window.setTimeout(
          read,
          status === "starting" ? LOG_REFRESH_MS / 2 : LOG_REFRESH_MS,
        );
      }
    };
    void read();
    return () => {
      cancelled = true;
      if (timer !== null) window.clearTimeout(timer);
    };
  }, [following, processId, source, status]);
  return log?.processId === processId ? log.text : null;
}

function ApplicationLogsPanel() {
  const { state, source } = useOrbitTool();
  const instanceId = state.status === "ready" ? state.page.instanceId : null;
  const [following, setFollowing] = useState(true);
  const [log, setLog] = useState<ApplicationLogUpdate>({
    text: "",
    status: "connecting",
    error: null,
  });
  const end = useRef<HTMLDivElement>(null);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- streams the application log from Orbit while following
  useEffect(() => {
    if (!source || instanceId === null || !following) return;
    return source.applicationLogs(instanceId, setLog);
  }, [source, instanceId, following]);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- scrolls the log viewport DOM to the newest line while following
  useEffect(() => {
    if (!following || !log.text) return;
    const viewport = end.current?.closest<HTMLElement>('[data-slot="scroll-area-viewport"]');
    if (viewport) viewport.scrollTop = viewport.scrollHeight;
  }, [following, log.text]);
  const lines = parseLogLines(log.text);
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex h-9 shrink-0 items-center gap-2 border-b px-3 text-xs">
        <span className="font-mono text-muted-foreground">storage/logs/laravel.log</span>
        <div className="ml-auto flex items-center gap-1">
          <span className="text-2xs text-muted-foreground">
            {following
              ? log.status === "live"
                ? "Live"
                : log.status === "refreshing"
                  ? "Refreshing"
                  : "Connecting…"
              : "Paused"}
          </span>
          <Button variant="ghost" size="xs" onClick={() => setFollowing((value) => !value)}>
            {following ? <Square /> : <Play />}
            {following ? "Pause" : "Follow"}
          </Button>
          <IconAction
            label="Copy application log"
            disabled={!log.text}
            onClick={() => void navigator.clipboard.writeText(log.text)}
          >
            <Copy />
          </IconAction>
        </div>
      </div>
      {log.error ? (
        <div className="border-b px-3 py-2 text-xs text-destructive">{log.error}</div>
      ) : null}
      <ScrollArea radius="none" scrollFade className="min-h-0 flex-1">
        <div className="py-2 font-mono text-xs leading-5">
          {lines.length ? (
            lines.map((line) => <LogLineRow key={line.id} time={line.time} text={line.text} />)
          ) : (
            <div className="px-3 text-muted-foreground">
              {log.status === "connecting" ? "Reading the application log…" : "No log lines yet"}
            </div>
          )}
          <div ref={end} />
        </div>
      </ScrollArea>
    </div>
  );
}

export function OrbitPanel() {
  const [tab, setTab] = useState<"instance" | "processes" | "logs" | "composer" | "javascript">(
    "instance",
  );
  const { state, refresh, act, warnings } = useOrbitTool();
  const dependencyResult = useOrbitDependencies();
  const dependencies = dependencyResult?.data;
  const [selectedId, setSelectedId] = useState<number | null>(null);
  const [follow, setFollow] = useState(true);
  const [busy, setBusy] = useState<ReadonlySet<number>>(new Set());
  const logEnd = useRef<HTMLDivElement>(null);

  const processes = state.status === "ready" ? state.processes : [];
  const selected = processes.find((process) => process.id === selectedId) ?? processes[0] ?? null;
  const canFollow = selected?.status === "running" || selected?.status === "starting";
  const following = follow && canFollow;
  const logText = useProcessLog(
    tab === "processes" ? (selected?.id ?? null) : null,
    selected?.status ?? null,
    following,
  );
  const lines = logText === null ? null : parseLogLines(logText);

  // Process states change behind our back (crashes, other clients); refresh while open.
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- refreshes the process list from Orbit on an interval
  useEffect(() => {
    const timer = window.setInterval(() => void refresh(), PROCESS_REFRESH_MS);
    return () => window.clearInterval(timer);
  }, [refresh]);

  // Keep the newest line in view while following.
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- scrolls the log viewport DOM to the newest line while following
  useEffect(() => {
    if (!following || logText === null) return;
    const viewport = logEnd.current?.closest<HTMLElement>('[data-slot="scroll-area-viewport"]');
    if (viewport) viewport.scrollTop = viewport.scrollHeight;
  }, [following, logText]);

  if (state.status !== "ready") return null;

  const run = async (targets: readonly OrbitProcess[], action: ProcessAction) => {
    const ids = targets.map((process) => process.id);
    setBusy((current) => new Set([...current, ...ids]));
    await Promise.all(targets.map((process) => act(process, action)));
    setBusy((current) => new Set([...current].filter((id) => !ids.includes(id))));
  };
  const running = processes.filter((process) => process.status === "running");
  const down = processes.filter(
    (process) => process.status === "stopped" || process.status === "crashed",
  );

  return (
    <PanelShell
      icon={OrbitIcon}
      title="Orbit"
      hasTabs
      flush
      actions={
        tab === "processes" ? (
          <div className="flex items-center gap-2">
            {processes.length > 0 ? (
              <ToolbarGroup>
                <Button
                  variant="ghost"
                  size="xs"
                  type="button"
                  disabled={down.length === 0}
                  onClick={() => void run(down, "start")}
                >
                  <Play />
                  <span className="ml-0.5">Start all</span>
                </Button>
                <Button
                  variant="ghost"
                  size="xs"
                  type="button"
                  disabled={running.length === 0}
                  onClick={() => void run(running, "restart")}
                >
                  <RotateCw />
                  <span className="ml-0.5">Restart all</span>
                </Button>
              </ToolbarGroup>
            ) : null}
          </div>
        ) : undefined
      }
    >
      <UnderlineTabs
        value={tab}
        onChange={setTab}
        warnings={warnings}
        tabs={[
          ["instance", "Instance"],
          ["processes", "Processes"],
          ["logs", "Logs"],
          ["composer", "Composer"],
          ["javascript", dependencies?.package_manager ?? "JavaScript"],
        ]}
      />
      {tab === "instance" ? (
        <ScrollArea radius="none" scrollFade hideScrollbars className="min-h-0 flex-1">
          <StatStrip>
            <Stat label="Processes" value={processes.length} />
            <Stat label="Running" value={running.length} tone="success" />
            <Stat
              label="Stopped"
              value={processes.filter((process) => process.status === "stopped").length}
            />
            <Stat
              label="Crashed"
              value={processes.filter((process) => process.status === "crashed").length}
              tone={
                processes.some((process) => process.status === "crashed") ? "danger" : "default"
              }
            />
          </StatStrip>
          <KeyValueRows
            rows={[
              ["Instance ID", state.page.instanceId],
              ["Domain", state.page.domain, "mono"],
              ["Node", state.page.nodeName ?? "–"],
            ]}
          />
        </ScrollArea>
      ) : tab === "logs" ? (
        <ApplicationLogsPanel />
      ) : tab === "composer" || tab === "javascript" ? (
        <DependenciesPanel tab={tab} result={dependencyResult} />
      ) : processes.length === 0 || !selected ? (
        <EmptyRow>This Orbit Instance runs no processes</EmptyRow>
      ) : (
        <div className="flex min-h-0 flex-1">
          <div className="w-72 shrink-0 border-r">
            <ScrollArea radius="none" hideScrollbars>
              {processes.map((process) => (
                <ProcessItem
                  key={process.id}
                  process={process}
                  selected={process.id === selected.id}
                  busy={busy.has(process.id)}
                  onSelect={() => setSelectedId(process.id)}
                  onAct={(action) => void run([process], action)}
                />
              ))}
            </ScrollArea>
          </div>
          <div className="flex min-w-0 flex-1 flex-col">
            <div className="flex h-9 shrink-0 items-center gap-2 border-b pr-1.5 pl-3 text-xs">
              <span className="font-mono">{selected.name}</span>
              <span className="min-w-0 truncate font-mono text-muted-foreground">
                {selected.command}
              </span>
              <div className="ml-auto flex shrink-0 items-center gap-0.5">
                {/* One control for following: green with a pulsing dot while it re-reads. */}
                <button
                  type="button"
                  aria-pressed={following}
                  disabled={!canFollow}
                  onClick={() => setFollow((value) => !value)}
                  className={cn(
                    "inline-flex h-6 cursor-pointer items-center gap-1.5 rounded-md px-2 font-medium text-xs outline-none focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-ring disabled:cursor-default disabled:opacity-50 [&_svg]:size-3.5",
                    following
                      ? "bg-success/15 text-success-foreground hover:bg-success/20"
                      : "text-muted-foreground hover:bg-foreground/6 hover:text-foreground",
                  )}
                >
                  {following ? (
                    <span className="size-1.5 animate-status-pulse rounded-full bg-success" />
                  ) : (
                    <ArrowDownToLine />
                  )}
                  {following ? "Following" : "Follow"}
                </button>
                <IconAction
                  label="Copy log"
                  disabled={!logText}
                  onClick={() => void navigator.clipboard.writeText(logText ?? "")}
                >
                  <Copy />
                </IconAction>
              </div>
            </div>
            {state.error ? (
              <div className="shrink-0 border-b px-3 py-2 text-destructive text-xs">
                {state.error}
              </div>
            ) : null}
            <ScrollArea radius="none" scrollFade className="min-h-0 flex-1">
              <div className="py-2 font-mono text-xs leading-5">
                {lines === null ? (
                  <div className="px-3 text-muted-foreground">Reading the log…</div>
                ) : lines.length === 0 ? (
                  <div className="px-3 text-muted-foreground">No log lines yet</div>
                ) : (
                  lines.map((line) => (
                    <LogLineRow key={line.id} time={line.time} text={line.text} />
                  ))
                )}
                <div ref={logEnd} />
              </div>
            </ScrollArea>
          </div>
        </div>
      )}
    </PanelShell>
  );
}
