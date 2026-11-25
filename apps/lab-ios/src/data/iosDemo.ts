import type { LabThread, ListThread } from "./fixtures";
// The paired Demo workspace in Conn's SwiftUI fidelity capture.
export const demoThread: LabThread = {
  key: "greeting",
  title: "Plan a greeting in main.rs",
  project: "Demo",
  branch: "main",
  instanceId: "codex",
  model: "GPT-6.2 Astra",
  minutesAgo: 7,
  entries: [
    {
      kind: "agentMessage",
      from: "Agent",
      minutesAgo: 7,
      text: "DEMO: look at main.rs and plan a greeting",
    },
    { kind: "work", label: "Worked for 13ms", steps: ["Read main.rs"] },
    {
      kind: "assistant",
      minutesAgo: 7,
      text: [
        "### What I found",
        "\n`main.rs` prints a fixed string and nothing else uses a greeting yet.",
        "\n1. Add a `greet(name: &str) -> String` helper.",
        "2. Call it from main.",
        "3. Cover it with a unit test.",
        "\n```rust",
        "fn greet(name: &str) -> String {",
        '    format!("Hello, {name}!")',
        "}",
        "```",
        "\n> The binary has no arguments yet, so the name stays fixed for now.",
      ].join("\n"),
    },
    {
      kind: "agentMessage",
      from: "Agent",
      minutesAgo: 4,
      text: "DEMO FOLLOWUP: do it, and run the tests",
    },
    { kind: "work", label: "Worked for 1.2s", steps: ["Edited main.rs", "Ran cargo test"] },
    {
      kind: "assistant",
      minutesAgo: 4,
      text: 'Done. greet now takes the name, and main passes `"Conn"`.\n\n**All 4 tests** pass. Next I can add a --name flag if you want it.',
    },
    {
      kind: "agentMessage",
      from: "Agent",
      minutesAgo: 2,
      text: "DEMO FOLLOWUP: now explain the change",
    },
    {
      kind: "assistant",
      minutesAgo: 2,
      text: 'Done. greet now takes the name, and main passes `"Conn"`.\n\n**All 4 tests** pass. Next I can add a --name flag if you want it.',
    },
  ],
};
export function listRow(t: LabThread): ListThread {
  return {
    key: t.key,
    title: t.title,
    project: t.project,
    ...(t.branch ? { branch: t.branch } : {}),
    state: "done",
    machine: "laptop",
    provider: t.instanceId,
    time: t.minutesAgo ? t.minutesAgo + "m" : "now",
  };
}

// In the lab, explicit project names stand in for the agent resolving a single Orbit project.
export function demoFilingProject(text: string): string {
  const words = new Set(text.toLowerCase().match(/[a-z0-9]+/g) ?? []);
  const apps = [
    "Conn",
    "Orbit",
    "Vault",
    "Hauzer",
    "Mealou",
    "Operator",
    "Annotator",
    "DesignKit",
    "Spaces",
    "Treadmill",
  ].filter((project) => words.has(project.toLowerCase()));
  if (apps.length) return apps.length === 1 ? apps[0]! : "General";
  const machines = ["Mini", "Beast"].filter((project) => words.has(project.toLowerCase()));
  if (/\bnick\.local\b|\bnick host\b/i.test(text)) machines.push("Nick");
  return machines.length === 1 ? machines[0]! : "General";
}
