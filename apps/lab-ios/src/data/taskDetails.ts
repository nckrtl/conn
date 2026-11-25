type SubtaskStatus = "To do" | "In progress" | "Completed" | "Failed";
type SubtaskDetails = {
  deliverables?: readonly string[];
  tokens?: number;
  minutes?: number;
  lines?: { added: number; removed: number };
};
type Subtask = SubtaskDetails & { title: string; brief: string; status: SubtaskStatus };
type TaskAgent = {
  role: string;
  provider: "codex" | "claudeAgent";
  model: string;
  state: "Working" | "Idle" | "Done" | "Failed";
  assignment: string;
};
export interface TaskDetailData {
  brief: string;
  status: string;
  workspace?: string;
  branch?: string;
  usage?: string;
  subtasks: readonly Subtask[];
  agents: readonly TaskAgent[];
}
const step = (
  title: string,
  status: SubtaskStatus,
  brief: string,
  details?: SubtaskDetails,
): Subtask => ({
  title,
  status,
  brief,
  ...details,
});
const implementer = (assignment: string, state: TaskAgent["state"] = "Working"): TaskAgent => ({
  role: "Implementer",
  provider: "codex",
  model: "GPT-5.5 Codex",
  assignment,
  state,
});

// The attachment and paste scenarios follow Expo's orbitTasksFixtures.
export const taskDetails: Readonly<Record<number, TaskDetailData>> = {
  482: {
    status: "In review",
    workspace: "conn-attachments",
    branch: "orbit/482-image-attachments",
    usage: "52m · 1.8M tokens",
    brief:
      "Let users attach images to a message in the composer on desktop and iOS.\n\n## Outcome\nA user can paste, drop or pick an image. It appears as a chip above the input and travels with the message to providers that accept images.\n\n## Constraints\n- Check the selected model’s image limits before upload.\n- Keep the input responsive while generating thumbnails.\n- Keep attachments with the draft when switching threads.",
    subtasks: [
      step(
        "Upload limits per provider",
        "Completed",
        "Expose each adapter’s size, type and model limits to the composer.",
        {
          deliverables: ["Provider limits", "Client-side validation"],
          tokens: 280_000,
          minutes: 12,
          lines: { added: 86, removed: 14 },
        },
      ),
      step(
        "Attachment chips in the composer",
        "In progress",
        "Show a thumbnail, filename and remove button above the input. Keep focus in the composer when removing a chip.",
        {
          deliverables: ["Attachment chip row", "Unsupported-model warning", "Browser tests"],
          tokens: 640_000,
          minutes: 21,
        },
      ),
      step(
        "Paste and drop handling",
        "To do",
        "Route pasted and dropped images into the current draft.",
      ),
      step(
        "iOS photo picker",
        "To do",
        "Connect the system photo picker to the same draft attachments.",
      ),
    ],
    agents: [
      implementer("Upload limits per provider", "Done"),
      implementer("Attachment chips in the composer", "Idle"),
      {
        role: "Reviewer",
        provider: "claudeAgent",
        model: "Claude Opus 5.5",
        state: "Working",
        assignment: "Review the pull request",
      },
    ],
  },
  479: {
    status: "In progress",
    workspace: "conn-paste-perf",
    branch: "orbit/479-paste-performance",
    usage: "12m · 310K tokens",
    brief:
      "Pasting into a long thread stalls the composer. Find the slow call and keep paste under one frame.",
    subtasks: [
      step(
        "Profile paste in a 2,000-message thread",
        "Completed",
        "Record the input trace and identify the blocking call.",
        { tokens: 180_000, minutes: 8, lines: { added: 12, removed: 2 } },
      ),
      step(
        "Defer draft persistence",
        "In progress",
        "Write the draft after the frame that displays the paste.",
        { tokens: 130_000, minutes: 4 },
      ),
      step(
        "Repeat the profile",
        "To do",
        "Compare input latency in the same thread before and after the fix.",
      ),
    ],
    agents: [implementer("Profile paste and verify the fix")],
  },
  476: {
    status: "Waiting for checks",
    workspace: "orbit-gateway",
    branch: "fix/tls-renewal",
    brief:
      "Renew the gateway certificate before expiry and verify the renewed certificate on the serving node.",
    subtasks: [
      step(
        "Schedule certificate renewal",
        "Completed",
        "Renew before the current certificate expires.",
        { tokens: 76_000, minutes: 6, lines: { added: 34, removed: 8 } },
      ),
      step(
        "Verify the new expiry date",
        "Completed",
        "Read the certificate served by the gateway after renewal.",
        { tokens: 24_000, minutes: 3, lines: { added: 11, removed: 0 } },
      ),
    ],
    agents: [implementer("Certificate renewal", "Done")],
  },
  471: {
    status: "In progress",
    workspace: "conn-question-context",
    brief:
      "Keep the agent’s last message visible when a question opens so the user can read the context before choosing an answer.",
    subtasks: [
      step(
        "Find the preceding message",
        "Completed",
        "Read the last agent response before the question.",
        { tokens: 87_000, minutes: 7, lines: { added: 28, removed: 6 } },
      ),
      step("Render the context", "Completed", "Show the response above the choices.", {
        tokens: 135_000,
        minutes: 12,
        lines: { added: 76, removed: 14 },
      }),
      step("Handle missing context", "Completed", "Keep standalone questions compact.", {
        tokens: 32_000,
        minutes: 4,
        lines: { added: 17, removed: 3 },
      }),
      step(
        "Check long messages",
        "In progress",
        "Keep the answer choices reachable with long context.",
        { tokens: 41_000, minutes: 5 },
      ),
      step("Verify both themes", "To do", "Compare the question on light and dark backgrounds."),
    ],
    agents: [implementer("Check long messages")],
  },
  468: {
    status: "Failed",
    workspace: "orbit-deploy",
    brief:
      "Retry deployment after a sleeping node becomes ready. The last attempt ended before the node accepted a connection.",
    subtasks: [
      step("Wait for node readiness", "Failed", "Observe the first successful readiness check.", {
        tokens: 58_000,
        minutes: 6,
      }),
      step("Retry the deployment", "To do", "Start the deploy once the node accepts work."),
      step("Verify recovery", "To do", "Exercise the flow with a sleeping node."),
    ],
    agents: [implementer("Wait for node readiness", "Failed")],
  },
  465: {
    status: "Completed",
    workspace: "hauzer-map",
    branch: "feat/map-view",
    brief: "Show household inventory on a map and open the items stored at a selected location.",
    subtasks: [
      step("Read locations", "Completed", "Load household locations.", {
        tokens: 97_000,
        minutes: 8,
        lines: { added: 42, removed: 5 },
      }),
      step("Place inventory pins", "Completed", "Group stored items by location.", {
        tokens: 231_000,
        minutes: 18,
        lines: { added: 124, removed: 23 },
      }),
      step("Open location details", "Completed", "List the items under the selected pin.", {
        tokens: 154_000,
        minutes: 12,
        lines: { added: 87, removed: 16 },
      }),
      step("Verify map navigation", "Completed", "Return from a location to the inventory list.", {
        tokens: 56_000,
        minutes: 5,
        lines: { added: 24, removed: 2 },
      }),
    ],
    agents: [implementer("Map and inventory navigation", "Done")],
  },
  459: {
    status: "In progress",
    workspace: "vault-sync",
    brief:
      "Preserve both edits after a sync conflict and identify the device that wrote each copy.",
    subtasks: [
      step("Keep both copies", "Completed", "Save each version as a recoverable record.", {
        tokens: 166_000,
        minutes: 13,
        lines: { added: 72, removed: 18 },
      }),
      step(
        "Identify the newer edit",
        "In progress",
        "Show the source device and update time in the conflict banner.",
        { tokens: 83_000, minutes: 7 },
      ),
    ],
    agents: [implementer("Identify the newer edit")],
  },
  474: {
    status: "To do",
    brief: "Reopen the preview tabs a user had open when the desktop app restarts.",
    subtasks: [
      step("Persist open tabs", "To do", "Save tab URLs per window."),
      step("Reopen on launch", "To do", "Restore the saved tabs before the first paint."),
    ],
    agents: [],
  },
  500: {
    status: "Backlog",
    brief: "Dropping image files anywhere on a thread attaches them to the draft.",
    subtasks: [],
    agents: [],
  },
};
