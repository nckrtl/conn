// What the Conn Server serves, read from its sources and its binary. Used by
// tools/bump-report.mjs and crates/conn-server/tools/{decode-coverage,capabilities-check}.mjs.
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { repoRoot } from "./monorepo.mjs";
import { sealedEnv } from "./sealed-env.mjs";

/** Every method of the contract, from the generated `methods.json`: [{ tag, stream }]. */
export function contractMethods() {
  const file = NodePath.join(repoRoot, "crates/conn-contract/methods.json");
  return JSON.parse(NodeFS.readFileSync(file, "utf8")).methods;
}

/**
 * Method tags the method table registers: every contract tag written as a string literal in
 * crates/conn-server/src/methods (tests and `table.get(..)` lookups left out). Registrations
 * put the tag on its own line or pass it through helpers, so this reads literals, not calls.
 * [`binaryCoverage`] cross-checks the count against the running server.
 */
export function registeredTags(tags) {
  const found = new Set();
  const walk = (dir) => {
    for (const entry of NodeFS.readdirSync(dir, { withFileTypes: true })) {
      const path = NodePath.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name !== "tests") walk(path);
      } else if (entry.name.endsWith(".rs") && entry.name !== "tests.rs") {
        const text = NodeFS.readFileSync(path, "utf8")
          .split(/\n#\[cfg\(test\)\]/)[0]
          .replace(/\.get\(\s*"[^"]*"\s*\)/g, "");
        for (const m of text.matchAll(/"([A-Za-z][A-Za-z0-9_.-]*)"/g)) if (tags.has(m[1])) found.add(m[1]);
      }
    }
  };
  walk(NodePath.join(repoRoot, "crates/conn-server/src/methods"));
  return found;
}

/** Every command type of the contract, from the generated `COMMAND_TYPES`. */
export function contractCommands() {
  const file = NodePath.join(repoRoot, "crates/conn-contract/src/generated.rs");
  const list = /^pub const COMMAND_TYPES: &\[&str\] = &\[([^\]]*)\];$/m.exec(NodeFS.readFileSync(file, "utf8"));
  return new Set(Array.from(list?.[1].matchAll(/"([^"]+)"/g) ?? [], (m) => m[1]));
}

/**
 * The command types the engine handles: every one of `types` that heads an arm of the `match`
 * in `fn handler` of crates/conn-engine/src/commands.rs, read from its signature to its
 * fallback arm. `fn refusal` names commands too, and the engine refuses those. Throws when the
 * match is not found or holds no command, so a reshaped handler fails the check instead of
 * emptying the set. tools/bump-report.mjs and crates/conn-server/tests/engine_commands.rs
 * find the match by the same two anchors.
 */
export function engineCommands(types) {
  const file = "crates/conn-engine/src/commands.rs";
  const text = NodeFS.readFileSync(NodePath.join(repoRoot, file), "utf8");
  const start = text.indexOf("fn handler(command_type: &str)");
  const end = start === -1 ? -1 : text.indexOf("_ => return None", start);
  if (end === -1) {
    throw new Error(`${file}: no \`fn handler(command_type: &str)\` with a \`_ => return None\` arm`);
  }
  const arms = text.slice(start, end).matchAll(/"([^"]+)"(?=\s*(?:=>|\|))/g);
  const handled = new Set(Array.from(arms, (m) => m[1]).filter((type) => types.has(type)));
  if (handled.size === 0) throw new Error(`${file}: no contract command heads an arm of \`fn handler\``);
  return handled;
}

/**
 * Starts `binary` once on a temp state folder, waits for `pattern` in its output and returns
 * what `use` makes of the match, or undefined. The process is stopped by PID before this
 * returns.
 */
async function started(binary, pattern, use) {
  if (!binary || !NodeFS.existsSync(binary)) return undefined;
  const program = NodePath.resolve(binary);
  const tmp = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "conn-served-"));
  const project = NodePath.join(tmp, "project");
  NodeFS.mkdirSync(project);
  const child = NodeChildProcess.spawn(
    program,
    ["--listen", "127.0.0.1:0", "--state-dir", NodePath.join(tmp, "state"), "--project", project],
    { cwd: tmp, stdio: ["ignore", "pipe", "pipe"], env: sealedEnv(tmp) },
  );
  try {
    const match = await new Promise((ok) => {
      let text = "";
      const timer = setTimeout(() => ok(undefined), 15000);
      child.stdout.on("data", (d) => {
        text += d;
        const m = pattern.exec(text);
        if (m) {
          clearTimeout(timer);
          ok(m);
        }
      });
      child.on("error", () => {
        clearTimeout(timer);
        ok(undefined);
      });
      child.on("exit", () => {
        clearTimeout(timer);
        ok(undefined);
      });
    });
    return match && (await use(match));
  } finally {
    if (child.exitCode === null) child.kill("SIGTERM");
    await new Promise((r) => (child.exitCode === null ? child.once("exit", r) : r()));
    NodeFS.rmSync(tmp, { recursive: true, force: true });
  }
}

/** The `methods:` line of `binary` (`81 of 235 methods (...)`), or undefined. */
export const binaryCoverage = (binary) => started(binary, /^methods: (.+)$/m, (m) => m[1]);

/** The `capabilities` of the descriptor that `binary` serves, or undefined. */
export const binaryCapabilities = (binary) =>
  started(binary, /^conn-server listening on (http:\/\/\S+)$/m, async (m) => {
    const response = await fetch(`${m[1]}/.well-known/t3/environment`);
    return (await response.json()).capabilities;
  });

/** The served count in a `methods:` line. */
export const servedCount = (line) => Number(/^(\d+) of/.exec(line ?? "")?.[1]);
