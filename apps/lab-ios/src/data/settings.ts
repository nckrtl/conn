export type Choice = {
  kind: "choice";
  label: string;
  hint: string;
  options: readonly string[];
};
type Preference =
  | Choice
  | { kind: "switch"; label: string; hint: string; initial: boolean }
  | { kind: "info"; label: string; hint: string; value?: string };
type Group = { title: string; rows: Preference[] };

const choice = (label: string, hint: string, ...options: string[]): Choice => ({
  kind: "choice",
  label,
  hint,
  options,
});
const toggle = (label: string, hint: string, initial: boolean): Preference => ({
  kind: "switch",
  label,
  hint,
  initial,
});
const info = (label: string, hint: string, value?: string): Preference => ({
  kind: "info",
  label,
  hint,
  ...(value && { value }),
});

export function settingsPages(offline: boolean) {
  return {
    Connections: [
      {
        title: "Orbit network",
        rows: [
          info(
            "Gateway",
            "Your iPhone uses its WireGuard identity to reach Orbit.",
            "gateway.orbit",
          ),
          info(
            "Connection",
            "Orbit discovers the Conn servers available to this device.",
            offline ? "Not connected" : "Connected",
          ),
        ],
      },
      {
        title: "Linked environments",
        rows: [
          info(
            "Primary agent",
            "General threads start on the primary agent node discovered by Orbit.",
          ),
          toggle(
            "Include beast",
            "Show this environment’s threads in the inbox. Its saved threads remain readable when the machine is offline.",
            true,
          ),
        ],
      },
    ],
    General: [
      {
        title: "Orbit profile",
        rows: [
          info(
            "Settings sync",
            "Your Orbit profile keeps shared appearance and workspace preferences together across devices.",
          ),
        ],
      },
      {
        title: "Threads",
        rows: [
          info(
            "New threads",
            "Start in General. When the work belongs to one Orbit project, Conn files the thread under that project automatically.",
          ),
          info(
            "Settled threads",
            "Settle finished conversations to move them out of the active list. Reopen them from Settled.",
          ),
        ],
      },
    ],
    Appearance: [
      {
        title: "Theme",
        rows: [
          choice(
            "Color theme",
            "Preview a Conn theme. Orbit profiles carry the theme choice across devices.",
            "Orbit profile",
            "Dark Ocean",
            "Dark Mono",
            "Light",
            "Grove",
            "Ocean",
            "Ember",
            "Iris",
          ),
        ],
      },
      {
        title: "Reading",
        rows: [
          choice(
            "Tool calls in chat",
            "Choose how much agent activity appears between messages.",
            "Show all",
            "Hide successful",
            "Hide all",
            "Zen",
          ),
          toggle("Word break", "Wrap long lines in code blocks and diffs.", false),
        ],
      },
    ],
    Chat: [
      {
        title: "While an agent is working",
        rows: [
          choice(
            "Follow-up messages",
            "Steer delivers your message during the current turn. Queue waits until the turn finishes.",
            "Steer",
            "Queue",
          ),
        ],
      },
    ],
    Voice: [
      {
        title: "Dictation",
        rows: [
          info(
            "Transcription service",
            "The iPhone records your voice. The Operator server transcribes it and returns text to the composer.",
            "Operator",
          ),
          info(
            "Network",
            offline
              ? "Reconnect to the Orbit network to use server dictation."
              : "Dictation needs a connection to the Operator server.",
          ),
        ],
      },
      {
        title: "This iPhone",
        rows: [
          info(
            "Microphone access",
            "Allow Conn to use the microphone in iOS Settings to start recording.",
          ),
        ],
      },
    ],
    Providers: [
      {
        title: "Agent drivers",
        rows: [
          info("Codex", "The environment supplies the Codex driver and its model catalog."),
          info("Claude", "Choose a Claude model from the environment when configuring a thread."),
          info(
            "ACP",
            "An environment can expose additional agents through the Agent Client Protocol.",
          ),
          info(
            "Model routing",
            "Drivers use the Orbit AI router or a CLI configured on the host. Available models depend on the environment.",
          ),
        ],
      },
    ],
    Threads: [
      {
        title: "Execution defaults",
        rows: [
          choice(
            "Workspace",
            "Use the current checkout or isolate changes in a new worktree.",
            "Current checkout",
            "New worktree",
          ),
          choice(
            "Default permissions",
            "Choose how much approval the agent needs when it works in a new thread.",
            "Approval required",
            "Auto-accept edits",
            "Auto",
            "Full access",
          ),
          choice(
            "Response streaming",
            "Read completed paragraphs as they arrive or wait for the full answer.",
            "Finished paragraphs",
            "After the turn",
          ),
          toggle(
            "Agent browser access",
            "Let an agent operate the connected preview browser.",
            false,
          ),
        ],
      },
      {
        title: "Thread lifecycle",
        rows: [
          toggle(
            "Auto-settle merged threads",
            "Settle a thread when its linked pull request merges.",
            true,
          ),
        ],
      },
    ],
    "Scheduled tasks": [
      {
        title: "Morning PR review",
        rows: [
          toggle(
            "Enabled",
            "The Conn server runs this agent prompt even while the iPhone is closed.",
            true,
          ),
          choice(
            "Trigger",
            "Run at a fixed time, at an interval, once, or when a matching webhook arrives.",
            "Fixed time",
            "Interval",
            "Once",
            "Webhook",
          ),
          choice(
            "Destination",
            "Choose where the agent posts its work.",
            "New thread",
            "Existing thread",
          ),
          info(
            "Project",
            "The schedule includes the project and execution environment for its runs.",
            "Conn",
          ),
        ],
      },
    ],
    Projects: [
      {
        title: "Orbit project",
        rows: [
          info(
            "Conn",
            "Orbit owns the project identity. Threads and delegated work use that identity across its environments.",
            "nckrtl/conn",
          ),
          info(
            "Pull requests",
            "Conn reads pull requests and submits reviews using the GitHub credentials available to the environment.",
            "GitHub",
          ),
          info(
            "Workspaces",
            "A project can have several checkouts or instances. Each has its own execution environment.",
          ),
        ],
      },
      {
        title: "Project defaults",
        rows: [
          choice(
            "Workspace",
            "Choose where to start work when a thread targets this project.",
            "Current checkout",
            "New worktree",
          ),
          info(
            "Project scripts",
            "Project actions run commands configured for the selected checkout.",
          ),
        ],
      },
    ],
    "Client storage": [
      {
        title: "On this iPhone",
        rows: [
          info(
            "Thread cache",
            "Saved thread lists and recent messages are available offline. Conn catches up when the environment reconnects.",
          ),
          info(
            "Credentials",
            "Clearing cached conversations keeps the credentials used to reconnect.",
          ),
        ],
      },
    ],
    About: [
      {
        title: "Conn for iOS",
        rows: [
          info("Build", "This browser preview uses sample workspace data.", "iOS design lab"),
          info("Open source licenses", "The native app lists notices for its bundled libraries."),
        ],
      },
    ],
  } satisfies Record<string, Group[]>;
}
export type SettingsPage = keyof ReturnType<typeof settingsPages>;
