// Whether a change needs the Conn Server checks: the workflow's `changes` job runs this on the
// full diff (`paths` filters see only 3,000 files). conn-server-checks-paths.test.cjs beside it
// holds the list against what the checks read.
// Usage: node .github/scripts/conn-server-checks-paths.cjs <`git diff -z --name-only` output>
const fs = require("node:fs");

// What the checks check out and read (conn-server-checks.yml): the Conn Server, the root
// rustfmt.toml that rustfmt finds above it, the toolchain pin in all three workflows that
// tools/check.sh compares, and this selector.
const PATHS = [
  "apps/conn-server/**",
  "rustfmt.toml",
  ".github/workflows/conn-server-checks.yml",
  ".github/workflows/conn-server-ci.yml",
  ".github/workflows/conn-server-release.yml",
  ".github/scripts/conn-server-checks-paths.cjs",
  ".github/scripts/conn-server-checks-paths.test.cjs",
];

/** GitHub path filter syntax: `**` crosses folders, `*` does not. */
function globToRegExp(glob) {
  let pattern = "";
  for (let index = 0; index < glob.length; index++) {
    const char = glob[index];
    if (glob.startsWith("**", index)) {
      pattern += "[\\s\\S]*";
      index += 1;
    } else if (char === "*") pattern += "[^/]*";
    else pattern += char.replace(/[.+^${}()|[\]\\]/g, "\\$&");
  }
  return new RegExp(`^${pattern}$`);
}

const RULES = PATHS.map(globToRegExp);

function matches(file) {
  return RULES.some((rule) => rule.test(file));
}

function main() {
  // NUL-separated: git quotes other names with unusual characters, and a name may hold "\n".
  const files = fs.readFileSync(process.argv[2], "utf8").split("\0").filter(Boolean);
  const hit = files.find(matches);
  console.error(
    hit
      ? `Runs the checks: ${JSON.stringify(hit)}`
      : `None of ${files.length} changed files is read.`,
  );
  console.log(`run=${Boolean(hit)}`);
}

if (require.main === module) main();

module.exports = { PATHS, matches };
