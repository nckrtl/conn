#!/usr/bin/env node
// The Claude Agent SDK version (AGENTS.md: the same SDK version as the T3 server). T3 pins a
// range in apps/server/package.json; its pnpm lockfile holds the version it runs. Fails when
// helpers/sdk-host pins another. An audit tool (tools/audit.sh); reads no node_modules.
//
//   node tools/sdk-pin.mjs
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

import { monorepoRoot, repoRoot } from "./monorepo.mjs";

const read = (root, rel) => NodeFS.readFileSync(NodePath.join(root, rel), "utf8");
const t3 = [
  ...new Set(
    [
      ...read(monorepoRoot, "pnpm-lock.yaml").matchAll(
        /\n {2}'?@anthropic-ai\/claude-agent-sdk@([0-9][^':(]*)'?:/g,
      ),
    ].map((m) => m[1]),
  ),
];
const hostLock = JSON.parse(read(repoRoot, "helpers/sdk-host/package-lock.json"));
const ours = [
  JSON.parse(read(repoRoot, "helpers/sdk-host/package.json")).dependencies?.[
    "@anthropic-ai/claude-agent-sdk"
  ],
  hostLock.packages?.["node_modules/@anthropic-ai/claude-agent-sdk"]?.version,
];
if (t3.length !== 1) {
  console.log(`FAIL one claude-agent-sdk version in pnpm-lock.yaml, found ${t3.join(", ")}`);
  process.exitCode = 1;
} else if (ours[0] !== t3[0] || ours[1] !== t3[0]) {
  console.log(`FAIL helpers/sdk-host pins ${ours.join(" / ")}; the T3 server locks ${t3[0]}`);
  process.exitCode = 1;
} else {
  console.log(`ok   helpers/sdk-host claude-agent-sdk ${t3[0]} = the T3 server's locked version`);
}
