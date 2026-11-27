import { FEED_THREAD } from "../../../lab-ios/src/data/fixtures";

export interface Thread {
  id: string;
  title: string;
  project: string;
  branch: string;
  age: string;
  prompt: string;
  reply: string;
  waiting?: boolean;
  provider?: "claude" | "openai";
  mark?: string | undefined;
  group?: string;
}

export const threads: Thread[] = [
  {
    id: "heroicons-lucide",
    title: "Expand Heroicons with Lucide Designs",
    project: "apps",
    branch: "heroicons-lucide",
    age: "4m",
    waiting: true,
    prompt: "How do the new glyphs look at sidebar size?",
    reply:
      "The solid 16 set keeps the small controls legible. The thread list and composer use the same glyphs.",
  },
  {
    id: "orbit-task-delivery",
    title: "Improve Orbit Task Delivery Speed",
    project: "orbit",
    branch: "main",
    age: "13m",
    waiting: true,
    prompt: "Where does task delivery spend its time?",
    reply:
      "The receipt arrives before the workspace is ready. The next step is to measure the time between those two events.",
  },
  {
    id: FEED_THREAD.key,
    title: FEED_THREAD.title,
    project: FEED_THREAD.project,
    branch: FEED_THREAD.branch ?? "",
    age: `${FEED_THREAD.minutesAgo}m`,
    provider: FEED_THREAD.instanceId === "claudeAgent" ? "claude" : "openai",
    prompt: "",
    reply: "",
  },
  {
    id: "orbit-task-receipt",
    title: "Hand two features to Orbit",
    project: "conn",
    branch: "main",
    age: "3h",
    prompt: "Hand the image attachments and the thread search work to Orbit.",
    reply: "I’ll create two Orbit tasks, one per feature.",
  },
  {
    id: "delegation-smoke",
    title: "Delegation test: agent → mini",
    project: "No project",
    branch: "",
    age: "3h",
    prompt:
      "Run the shell command `hostname`. Then call conn_thread_send with environmentId 19d47977-2bb3-4… and the result.",
    reply: "CHILD DONE mini",
  },
  {
    id: "image-attachments",
    title: "Plan image attachments in the composer",
    project: "conn",
    branch: "main",
    age: "5h",
    prompt: "How should paste and drop work in the composer?",
    reply:
      "Keep the attachment visible until the message is sent. Show a preview, the filename, and a remove action on each chip.",
  },
  {
    id: "flaky-sync-tests",
    title: "Fix the flaky sync tests",
    project: "conn",
    branch: "fix/sync-tests",
    age: "10h",
    waiting: true,
    prompt: "Can we make the cache test deterministic?",
    reply:
      "Wait for the cache write to finish before reopening the thread. The test can then assert the restored messages directly.",
  },
];

// The compact delegation workspace in the native comparison capture.
const referenceSidebar = [
  [
    "server-cache",
    "Build Conn Server thread cache",
    "conn",
    "feature/restore-branch",
    "1h",
    "What should the thread cache store?",
    "Keep the thread list and the latest messages together so reopening a thread can paint from disk.",
  ],
  [
    "ios-cache",
    "iOS offline cache, foreground sync",
    "conn",
    "feature/offline-model",
    "14m",
    "How does the list catch up when iOS comes back to the foreground?",
    "Show the cached list first, then apply thread updates from each connected environment.",
  ],
  [
    "gpui-cache",
    "GPUI offline cache production pass",
    "conn",
    "feature/offline-model",
    "14m",
    "Can GPUI reopen a cached thread while the server is offline?",
    "The sidebar and the latest messages can load from disk. When the connection returns, the timeline can catch up without moving the scroll position.",
  ],
  [
    "storage",
    "Conn External Storage",
    "apps",
    "",
    "2h",
    "Which data belongs in local storage?",
    "The local copy holds the thread outline and recent messages. The server supplies older messages when you scroll back.",
  ],
  [
    "link-mini",
    "Link mini to the agent node",
    "No project",
    "",
    "3h",
    "Which environment should this child thread use?",
    "Select mini in the environment picker before starting the child thread.",
  ],
  [
    "agent-smoke",
    "agent smoke",
    "No project",
    "",
    "3h",
    "Which host handled the child run?",
    "mini",
  ],
  [
    "free-space",
    "Find and Free Disk Space",
    "No project",
    "",
    "4m",
    "Where is the build using disk space?",
    "The largest items in this example are the incremental build directory and the local debug artifacts.",
  ],
  [
    "cached-threads",
    "GPUI cached thread list restoration",
    "conn",
    "spike/cached",
    "55m",
    "What happens when I reopen a long thread?",
    "The thread list and recent messages appear first. Older messages load when you jump to an earlier prompt.",
  ],
  [
    "annotator-remarks",
    "Annotator remarks",
    "apps",
    "",
    "12m",
    "Check the spacing above the thread title.",
    "The native card uses the same title inset in both appearances.",
  ],
  [
    "performance",
    "Thread performance",
    "apps",
    "",
    "1m",
    "Where should we measure startup?",
    "Measure from navigation to the first visible thread text, then repeat with a warm cache.",
  ],
  [
    "node",
    "Agent node delegation",
    "Conn - Dev",
    "t3/9-dev",
    "8m",
    "Send the child task to mini.",
    "The child thread is attached to the selected environment.",
  ],
  [
    "zed",
    "Zed editor support",
    "Conn - Dev",
    "",
    "12m",
    "Can I use Zed to open a workspace?",
    "Open thread details and choose Zed from the editor menu.",
  ],
] as const;
const capturedThreads: Thread[] = referenceSidebar.map(
  ([id, title, project, branch, age, prompt, reply]) => ({
    id,
    title,
    project,
    branch,
    age,
    prompt,
    reply,
    provider: ["link-mini", "agent-smoke", "annotator-remarks", "node"].includes(id)
      ? "claude"
      : "openai",
    waiting: ["ios-cache", "gpui-cache", "free-space", "annotator-remarks", "node", "zed"].includes(
      id,
    ),
    mark: ["link-mini", "free-space"].includes(id)
      ? "folder"
      : ["annotator-remarks", "performance"].includes(id)
        ? "idea"
        : undefined,
    group: id === "agent-smoke" ? "General" : project,
  }),
);
export const delegationThread = threads.find((t) => t.id === "delegation-smoke")!;
export const imageGallery: Thread = {
  id: "twelve-images",
  title: "Twelve image attachments",
  project: "conn",
  branch: "",
  age: "now",
  prompt: "Here are the 12 images.",
  reply: "",
};
export const filesThread: Thread = {
  id: "files-walkthrough",
  title: "Trace the order total",
  project: "orders",
  branch: "main",
  age: "now",
  prompt: "Where does the order total on this page come from?",
  reply:
    "The controller passes the order to the Blade view. Here is where the template displays its total.",
};
/** A running turn with follow-ups in the queue tray (`?queue=`, `?pending=`). */
export const queueThread: Thread = {
  id: "queued-follow-ups",
  title: "Queued follow-ups",
  project: "conn",
  branch: "main",
  age: "now",
  waiting: true,
  provider: "claude",
  prompt: "Run the whole test suite and fix what breaks.",
  reply: "",
};
/** Finished background commands, notices and warnings (`?work=`, `?expanded=1`). */
export const backgroundThread: Thread = {
  id: "background-commands",
  title: "Background commands",
  project: "conn",
  branch: "main",
  age: "now",
  provider: "claude",
  prompt: "Rebuild the dev app and tell me when it is up.",
  reply: "The rebuild runs in the background. I will report when it ends.",
};
export const comparisonThreads = [
  ...capturedThreads.slice(0, 4),
  delegationThread,
  ...capturedThreads.slice(4),
  ...threads.filter((t) => t !== delegationThread),
  filesThread,
  queueThread,
  backgroundThread,
  imageGallery,
  {
    ...imageGallery,
    id: "image-layouts",
    title: "Image attachment layouts",
    prompt: "",
  },
];
export const defaultThread = threads[3]!;
export const tasks = [
  {
    id: 482,
    title: "Image attachments in the composer",
    status: "Working",
    pr: 1931,
    brief: "Show pasted and dropped images in the message composer.",
    subtasks: [
      "Upload limits per provider",
      "Attachment chips in the composer",
      "Paste and drop handling",
      "iOS photo picker",
    ],
  },
  {
    id: 470,
    title: "Thread search across environments",
    status: "In review",
    pr: 1902,
    brief: "Search connected environments and open a matching thread.",
    subtasks: ["Search index per environment", "Merge results in the sidebar", "Jump to a match"],
  },
] as const;
export type Task = (typeof tasks)[number];

export const panels = ["Tasks", "Files", "Pull requests", "Database", "MCP", "API"] as const;
export type Panel = (typeof panels)[number];
