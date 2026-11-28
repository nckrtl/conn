// The Conn Server checks run only when a change touches what they read. The checks job reads
// only its sparse checkout, so every path in it must be selected, and nothing outside it.
// Run: node --test .github/scripts/conn-server-checks-paths.test.cjs
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const { matches } = require("./conn-server-checks-paths.cjs");

const root = path.resolve(__dirname, "../..");
const workflow = fs.readFileSync(
  path.join(root, ".github/workflows/conn-server-checks.yml"),
  "utf8",
);

/** The sparse checkout of the checks job: the block after the second `sparse-checkout: |`. */
function checkedOut() {
  const blocks = [...workflow.matchAll(/sparse-checkout: \|\n((?: {12}\S.*\n)+)/g)];
  assert.equal(blocks.length, 2, "the changes job and the checks job each check out sparsely");
  return blocks[1][1]
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
}

test("every path the checks job checks out is selected", () => {
  for (const entry of checkedOut()) {
    const relative = entry.replace(/^\//, "");
    const probe = relative.endsWith("/") ? `${relative}any/file` : relative;
    assert.ok(matches(probe), `${entry} is checked out and not selected`);
  }
});

test("the workflows tools/check.sh reads the toolchain pin from are selected", () => {
  const check = fs.readFileSync(path.join(root, "apps/conn-server/tools/check.sh"), "utf8");
  const names = /conn-server-\{([^}]+)\}\.yml/.exec(check)?.[1].split(",") ?? [];
  assert.ok(names.length > 0, "tools/check.sh names its workflows");
  for (const name of names) {
    assert.ok(matches(`.github/workflows/conn-server-${name}.yml`), name);
  }
});

test("the TypeScript tree and the native apps do not start the checks", () => {
  for (const file of [
    "apps/server/src/bin.ts",
    "apps/web/src/main.tsx",
    "packages/contracts/src/environment.ts",
    "pnpm-lock.yaml",
    "crates/conn-state/src/lib.rs",
    "apps/conn-gpui/Cargo.toml",
    "Cargo.lock",
  ]) {
    assert.equal(matches(file), false, file);
  }
  assert.ok(matches("apps/conn-server/crates/conn-server/src/serve.rs"));
});
