// The capability gate: the server advertises a capability if and only if it serves it.
//
//   node crates/conn-server/tools/capabilities-check.mjs <conn-server binary>
//
// `capabilities.json` gives every flag of the contract's `ExecutionEnvironmentCapabilities` one
// row that says what proves it:
//
//   methods, commands   the RPC methods and engine commands the flag promises. All registered:
//                       the server serves it, and must advertise it. One missing: it must not.
//     + off             registered, and still not advertised: the reason. Shrinks only.
//     + when            advertised on some hosts or starts only: the reason.
//     + proof           optional, for a flag that promises more than its registration shows:
//                       the test or check that shows the rest. The gate does not read it.
//   behaviour           no method proves it: where the behaviour lives. Advertised.
//   undecided           nobody has looked: what the flag promises. Not advertised.
//
// The gate reads the flags from the contract, what the T3 server declares from
// apps/server/src/environment/ServerEnvironment.ts, the registered methods and the engine's
// commands from the sources, and the advertised flags from the binary's own descriptor. It
// fails when a flag has no row, when a row names a method or a command that does not exist,
// and when a row and the descriptor disagree. So a new upstream flag needs a decision, and a
// newly registered method turns its flag on or fails here.
//
// Its strength is the row: a `behaviour` row is a decision, and an `undecided` row proves
// nothing. The summary prints both counts.
import * as NodeFS from "node:fs";
import * as NodeURL from "node:url";

import { inMonorepo } from "../../../tools/monorepo.mjs";
import {
  binaryCapabilities,
  contractCommands,
  contractMethods,
  engineCommands,
  registeredTags,
} from "../../../tools/served.mjs";

const [binary] = process.argv.slice(2);
if (!binary) throw new Error("usage: capabilities-check.mjs <conn-server binary>");

const contractFile = "packages/contracts/src/environment.ts";
const struct = /^export const ExecutionEnvironmentCapabilities = Schema\.Struct\(\{\n([\s\S]*?)^\}\);/m.exec(
  NodeFS.readFileSync(inMonorepo(contractFile), "utf8"),
);
const flags = Array.from(struct?.[1].matchAll(/^ {2}(\w+):/gm) ?? [], (m) => m[1]);
if (flags.length === 0) throw new Error(`no ExecutionEnvironmentCapabilities in ${contractFile}`);

const t3File = "apps/server/src/environment/ServerEnvironment.ts";
const t3Source = NodeFS.readFileSync(inMonorepo(t3File), "utf8");
const t3 = new Set(flags.filter((flag) => new RegExp(`\\b${flag}\\b`).test(t3Source)));

const rowsFile = NodeURL.fileURLToPath(new URL("capabilities.json", import.meta.url));
const rows = JSON.parse(NodeFS.readFileSync(rowsFile, "utf8"));
const methods = new Set(contractMethods().map((m) => m.tag));
const registered = registeredTags(methods);
const commandTypes = contractCommands();
const commands = engineCommands(commandTypes);

const capabilities = await binaryCapabilities(binary);
if (!capabilities) throw new Error(`${binary} served no environment descriptor`);
const advertised = new Set(Object.keys(capabilities).filter((flag) => capabilities[flag] !== false));

const failures = [];
const fail = (flag, message) => failures.push(`${flag}: ${message}`);
const tally = { registration: 0, decision: 0, absent: 0, off: [], sometimes: [], undecided: [] };

for (const flag of Object.keys(rows)) {
  if (!flags.includes(flag)) fail(flag, "is no flag of the contract: remove the row");
}
for (const flag of advertised) {
  if (!t3.has(flag)) fail(flag, `is advertised, and ${t3File} does not declare it`);
}

for (const flag of flags) {
  const row = rows[flag];
  const on = advertised.has(flag);
  if (!row) {
    fail(flag, "has no row in capabilities.json: say what proves it");
    continue;
  }
  const proof = [...(row.methods ?? []), ...(row.commands ?? [])];
  const kinds = [proof.length > 0, "behaviour" in row, "undecided" in row].filter(Boolean).length;
  if (kinds !== 1 || (proof.length === 0 && ("off" in row || "when" in row))) {
    fail(flag, "needs one of: methods or commands (with `off` or `when`), behaviour, undecided");
    continue;
  }
  for (const method of row.methods ?? []) {
    if (!methods.has(method)) fail(flag, `${method} is no method of the contract`);
  }
  for (const command of row.commands ?? []) {
    if (!commandTypes.has(command)) fail(flag, `${command} is no command of the contract`);
  }

  if ("behaviour" in row) {
    if (on) tally.decision += 1;
    else fail(flag, "the row says the server serves it, and the server does not advertise it");
    continue;
  }
  if ("undecided" in row) {
    if (on) fail(flag, "is advertised with nothing to prove it: say what does");
    else tally.undecided.push(flag);
    continue;
  }
  const missing = [
    ...(row.methods ?? []).filter((method) => !registered.has(method)),
    ...(row.commands ?? []).filter((command) => !commands.has(command)),
  ];
  const served = missing.length === 0;
  if (on && !served) fail(flag, `is advertised, and the server does not register ${missing.join(", ")}`);
  else if (on && "off" in row) fail(flag, "is advertised now: remove `off`");
  else if (on) tally.registration += 1;
  else if (!served && "off" in row) fail(flag, `is not served (${missing.join(", ")}): remove \`off\``);
  else if (!served) tally.absent += 1;
  else if ("off" in row) tally.off.push(flag);
  else if ("when" in row) tally.sometimes.push(flag);
  else fail(flag, `the server registers ${proof.join(", ")} and does not advertise the flag`);
}

if (failures.length > 0) {
  console.log(`FAIL capabilities (${failures.length}); the rows are in ${rowsFile}:`);
  for (const failure of failures) console.log(`  ${failure}`);
  process.exitCode = 1;
}
console.log(
  `${advertised.size} of ${flags.length} capabilities advertised (the T3 server declares ${t3.size}): ` +
    `${tally.registration} proven by what is registered, ${tally.decision} by decision`,
);
console.log(`not advertised: ${tally.absent} not registered`);
console.log(`  registered, off on this start (${tally.sometimes.length}): ${tally.sometimes.join(", ")}`);
console.log(`  registered, off with a reason (${tally.off.length}): ${tally.off.join(", ")}`);
console.log(`  undecided (${tally.undecided.length}): ${tally.undecided.join(", ")}`);
