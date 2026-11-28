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

const COMMANDS_RS = "crates/conn-engine/src/commands.rs";
const HANDLER = "fn handler(command_type: &str)";
const FALLBACK = "_ => return None";

/**
 * The command types that head an arm of `fn handler` in crates/conn-engine/src/commands.rs,
 * before any contract filter: each string literal before `=>` or `|` between the function's
 * signature and its fallback arm, comments left out. `fn refusal` names commands too, and the
 * engine refuses those, so the span must be the body of `fn handler` and nothing else. This
 * throws when the signature or the fallback arm is missing, when another `fn` starts in
 * between, when an arm is under `#[cfg]`, and when there is no arm.
 *
 * One limit, on the safe side: a command the engine serves another way (an arm moved to a
 * helper, an arm with a guard, a type `dispatch_claimed` in engine.rs serves first) is missing
 * here without an error. A short set can only make the capability check refuse a row, never
 * accept a flag without proof.
 */
export function handlerArms() {
  const unread = (why) => new Error(`tools/served.mjs cannot read \`fn handler\` in ${COMMANDS_RS}: ${why}`);
  const text = NodeFS.readFileSync(NodePath.join(repoRoot, COMMANDS_RS), "utf8");
  const start = text.indexOf(HANDLER);
  if (start === -1) throw unread(`no \`${HANDLER}\``);
  const rest = text.slice(start + HANDLER.length).replace(/\/\/.*|\/\*[\s\S]*?\*\//g, "");
  const end = rest.indexOf(FALLBACK);
  if (end === -1) throw unread(`no \`${FALLBACK}\` arm after the signature`);
  const body = rest.slice(0, end);
  if (/^[ \t]*(?:[\w()]+[ \t]+)*fn[ \t]+\w/m.test(body)) {
    throw unread(`another \`fn\` starts before the \`${FALLBACK}\` arm`);
  }
  if (body.includes("#[cfg(")) throw unread("an arm under `#[cfg]` is handled in some builds only");
  const arms = Array.from(body.matchAll(/"([^"]+)"(?=\s*(?:=>|\|))/g), (m) => m[1]);
  if (arms.length === 0) throw unread("no string arm");
  return arms;
}

/** The command types the engine handles: every one of `types` among [`handlerArms`]. */
export function engineCommands(types) {
  const handled = new Set(handlerArms().filter((type) => types.has(type)));
  if (handled.size === 0) throw new Error(`${COMMANDS_RS}: no contract command heads an arm of \`fn handler\``);
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
