import { useCallback, useEffect, useState } from "react";

export const SCREENS = {
  settings: { label: "Settings", states: ["current", "proposed"] },
  "thread-approval": {
    label: "Thread · approval",
    states: ["command", "long", "session", "two", "six"],
  },
  "thread-question": {
    label: "Thread · question",
    states: ["single", "selected", "multi-1", "multi-2", "multi-3", "long", "cant-submit"],
  },
  thread: { label: "Thread · feed", states: [] },
  "thread-list": { label: "Inbox", states: ["demo", "populated"] },
  "pull-requests": { label: "Pull requests", states: ["populated", "empty"] },
  "task-detail": { label: "Task detail", states: ["overview", "subtasks", "agents"] },
  "pr-detail": {
    label: "Pull request detail",
    states: ["overview", "checks", "timeline", "code"],
  },
  "new-chat": { label: "New thread", states: ["blank", "example"] },
  tasks: { label: "Tasks", states: ["loaded", "unavailable"] },
} as const;

export const LAUNCH_STATES = {
  splash: "Splash",
  setup: "Local setup",
  workspace: "Last screen",
  offline: "Offline",
} as const;

export const CONNECTIONS = {
  online: "Orbit available",
  "no-network": "Off Orbit network",
  "no-gateway": "Gateway unavailable",
} as const;
export type Connection = keyof typeof CONNECTIONS;
export type LaunchFailure = Exclude<Connection, "online">;
export const LAUNCH_DELAYS = {
  splash: 550,
  checking: 1200,
  downloading: 1500,
  finalizing: 1000,
} as const;
export type LaunchState = keyof typeof LAUNCH_STATES | LaunchFailure | keyof typeof LAUNCH_DELAYS;
export function isTimedPhase(phase: string): phase is keyof typeof LAUNCH_DELAYS {
  return Object.hasOwn(LAUNCH_DELAYS, phase);
}

function readLaunch(value: string | null): LaunchState {
  if (value === "first-use") return "splash";
  if (value === "initializing") return "downloading";
  if (value === "no-network" || value === "no-gateway") return value;
  if (value && (isTimedPhase(value) || Object.hasOwn(LAUNCH_STATES, value)))
    return value as LaunchState;
  return "workspace";
}

const LAST_ROUTE = "conn.ios-lab.last-route";

export type ScreenId = keyof typeof SCREENS;
export type ThemeChoice = "dark-ocean" | "dark-mono" | "light" | "both";

/** The Tasks insight block's design variants, compared with `&insights=a|b|c`. */
export const INSIGHT_VARIANTS = ["a", "b", "c"] as const;
export type InsightVariant = (typeof INSIGHT_VARIANTS)[number];

export interface LabUrlState {
  readonly screen: ScreenId;
  readonly launch: LaunchState;
  readonly connection: Connection;
  readonly device: "new" | "saved";
  readonly thread: string;
  readonly item: string;
  readonly file: string;
  readonly theme: ThemeChoice;
  readonly state: string;
  readonly scale: number;
  readonly insights?: InsightVariant | undefined;
}

const DEFAULTS: LabUrlState = {
  thread: "",
  item: "",
  file: "",
  launch: "workspace",
  connection: "online",
  device: "saved",
  screen: "thread-list",
  theme: window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark-ocean" : "light",
  state: "",
  scale: 0,
};

function read(): LabUrlState {
  const params = new URLSearchParams(window.location.search);
  // An explicit screen always wins over this browser's saved preview.
  let route = params;
  const launch = params.get("launch");
  let savedScreen = false;
  if (launch) {
    try {
      const saved = localStorage.getItem(LAST_ROUTE);
      savedScreen = !!saved;
      if (saved && !params.has("screen")) route = new URLSearchParams(saved);
    } catch {
      /* Explicit preview links still work without storage. */
    }
  }
  const screen = route.get("screen");
  const failure = launch === "no-network" || launch === "no-gateway" ? launch : undefined;
  const connection = params.get("connection") ?? failure;
  const device = params.get("device");
  const theme = params.get("theme");
  const scale = Number(params.get("scale"));
  const resolved: ScreenId =
    screen && Object.hasOwn(SCREENS, screen) ? (screen as ScreenId) : DEFAULTS.screen;
  const states: readonly string[] = SCREENS[resolved].states;
  const state = route.get("state") ?? "";
  const insights =
    resolved === "tasks" && state !== "unavailable"
      ? (INSIGHT_VARIANTS.find((variant) => variant === route.get("insights")) ??
        (state === "strip" || state === "chart" ? "b" : undefined))
      : undefined;
  return {
    insights,
    screen: resolved,
    launch: readLaunch(launch),
    connection: connection === "no-network" || connection === "no-gateway" ? connection : "online",
    device:
      device === "new" || device === "saved"
        ? device
        : launch === "first-use" || (launch && !params.has("screen") && !savedScreen)
          ? "new"
          : "saved",
    file: resolved === "pr-detail" && state === "code" ? (route.get("file") ?? "") : "",
    item: route.get("item") ?? "",
    thread: route.get("thread") ?? "",
    theme:
      theme === "light" || theme === "both" || theme === "dark-mono" || theme === "dark-ocean"
        ? theme
        : DEFAULTS.theme,
    state: insights
      ? state === "chart"
        ? "chart"
        : "strip"
      : states.includes(state)
        ? state
        : (states[0] ?? ""),
    scale: Number.isFinite(scale) && scale >= 0.25 && scale <= 3 ? scale : DEFAULTS.scale,
  };
}

/** The lab's URL as React state; every change rewrites the query without a reload. */
export function useLabUrlState() {
  const [state, setState] = useState(read);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- the browser's back button changes the URL outside React
  useEffect(() => {
    const onPop = () => setState(read());
    window.addEventListener("popstate", onPop);
    return () => window.removeEventListener("popstate", onPop);
  }, []);
  const update = useCallback(
    (patch: Partial<LabUrlState>) => {
      const next = { ...state, ...patch };
      if (next.screen !== "tasks") next.insights = undefined;
      // A new screen starts at its first state.
      if (patch.screen && patch.state === undefined)
        next.state = next.insights ? "strip" : (SCREENS[patch.screen].states[0] ?? "");
      if (patch.screen) next.item = patch.item ?? "";
      if (patch.screen || next.screen !== "pr-detail" || next.state !== "code") next.file = "";
      const params = new URLSearchParams();
      if (next.file) params.set("file", next.file);
      if (next.item) params.set("item", next.item);
      params.set("screen", next.screen);
      if (next.thread && next.screen === "thread") params.set("thread", next.thread);
      params.set("theme", next.theme);
      if (next.state) params.set("state", next.state);
      if (next.screen === "tasks" && next.insights) params.set("insights", next.insights);
      if (next.launch !== "workspace") params.set("launch", next.launch);
      if (next.launch !== "workspace" || next.device === "new") params.set("device", next.device);
      if (
        next.connection !== "online" ||
        next.launch === "no-network" ||
        next.launch === "no-gateway"
      )
        params.set("connection", next.connection);
      if (next.scale) params.set("scale", String(next.scale));

      const newScreen = next.screen !== state.screen;
      const openingFile = !!next.file && next.file !== state.file;
      window.history[newScreen || openingFile ? "pushState" : "replaceState"](
        newScreen
          ? { fromScreen: state.screen }
          : openingFile
            ? { fromCodeList: true }
            : window.history.state,
        "",
        `?${params.toString()}`,
      );
      setState(next);
    },
    [state],
  );
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- Remember the open workspace route across launches of the preview.
  useEffect(() => {
    if (state.launch !== "workspace" && state.launch !== "offline") return;
    const route = new URLSearchParams({
      screen: state.screen,
      state: state.state,
      thread: state.thread,
      item: state.item,
      file: state.file,
    });
    if (state.screen === "tasks" && state.insights) route.set("insights", state.insights);
    try {
      localStorage.setItem(LAST_ROUTE, route.toString());
    } catch {
      /* Private previews can still replay the current route. */
    }
  }, [
    state.screen,
    state.state,
    state.thread,
    state.item,
    state.file,
    state.launch,
    state.insights,
  ]);
  return [state, update] as const;
}
