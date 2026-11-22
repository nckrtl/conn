// Whether a change needs the Conn Server checks: the workflow's `changes` job runs this on the
// full diff (`paths` filters see only 3,000 files). scripts/conn-server-checks-paths.test.ts
// fails when a file the checks read is outside PATHS.
// Usage: node .github/scripts/conn-server-checks-paths.cjs <`git diff -z --name-only` output>
const fs = require("node:fs");

// GitHub path filter syntax: `**` crosses folders, `*` does not, and the last matching
// pattern decides (`!` excludes).
const PATHS = [
  "apps/conn-server/**",
  "apps/server/**",
  // Every package apps/server imports, and annotation-overlay, whose `prepare` builds on `vp i`.
  "packages/**",
  "!packages/client-runtime/**",
  "packages/client-runtime/src/authorization/remote.ts",
  "packages/client-runtime/src/connection/compatibility.ts",
  "packages/client-runtime/src/connection/model.ts",
  "packages/client-runtime/src/environment/descriptor.ts",
  "packages/client-runtime/src/environment/endpoint.ts",
  "packages/client-runtime/src/errors/translatable.ts",
  "packages/client-runtime/src/orbitGateway/client.ts",
  "packages/client-runtime/src/orbitGateway/operationNotices.ts",
  "packages/client-runtime/src/orbitGateway/realtimeSubscription.ts",
  "packages/client-runtime/src/platform/capabilities.ts",
  "packages/client-runtime/src/providerClients.ts",
  "packages/client-runtime/src/rpc/http.ts",
  "packages/client-runtime/src/sourceControlClients.ts",
  "packages/client-runtime/src/state/models.ts",
  "packages/client-runtime/src/state/orchestrationV2Projection.ts",
  "packages/client-runtime/src/state/shellReducer.ts",
  "packages/client-runtime/src/state/subagentDisplay.ts",
  "packages/client-runtime/src/state/subagentRuntime.ts",
  "packages/client-runtime/src/state/threadCheckpoints.ts",
  "packages/client-runtime/src/state/threadExecution.ts",
  "packages/client-runtime/src/state/threadRelationships.ts",
  "packages/client-runtime/src/threadPullRequests.ts",
  "packages/client-runtime/src/work-log/commandLabel.ts",
  "packages/client-runtime/tsconfig.json",
  // apps/server/vite.config.ts, for the T3 tests the tools run.
  "vite.config.ts",
  ".task-cache.json",
  "infra/task-cache/src/remoteCache.ts",
  "scripts/lib/brand-assets.ts",
  "scripts/lib/cached-tests.ts",
  "scripts/lib/cli-executable-imports.ts",
  "scripts/lib/cli-external-packages.ts",
  "scripts/lib/linux-arm64-sea.ts",
  "scripts/lib/public-config.ts",
  "scripts/lib/tagged-source-version.ts",
  "tsconfig.base.json",
  "tsconfig.effect.json",
  // Install inputs, with the tarballs pnpm-lock.yaml installs from.
  "**/package.json",
  "pnpm-lock.yaml",
  "pnpm-workspace.yaml",
  ".pnpmfile.cjs",
  "patches/**",
  "apps/mobile/deps/*.tgz",
  // tools/check.sh checks the Rust toolchain pin in all three.
  ".github/workflows/conn-server-checks.yml",
  ".github/workflows/conn-server-ci.yml",
  ".github/workflows/conn-server-release.yml",
  ".github/scripts/conn-server-checks-paths.cjs",
  // Config git, cargo, pnpm, npm and Node read from any folder above the files they use.
  "**/.gitattributes",
  "**/.cargo/**",
  "**/.npmrc",
  "**/.node-version",
  "**/.nvmrc",
  "**/.tool-versions",
  // scripts/lib/public-config.ts loads these from the root.
  ".env",
  ".env.local",
  // Vendored references; no job checks them out.
  "!.repos/**",
];

function globToRegExp(glob) {
  let pattern = "";
  for (let index = 0; index < glob.length; index++) {
    const char = glob[index];
    if (glob.startsWith("**/", index)) {
      pattern += "(?:[\\s\\S]*/)?";
      index += 2;
    } else if (glob.startsWith("**", index)) {
      pattern += "[\\s\\S]*";
      index += 1;
    } else if (char === "*") pattern += "[^/]*";
    else if (char === "?") pattern += "[^/]";
    else pattern += char.replace(/[.+^${}()|[\]\\]/g, "\\$&");
  }
  return new RegExp(`^${pattern}$`);
}

const RULES = PATHS.map((path) => ({
  exclude: path.startsWith("!"),
  glob: globToRegExp(path.replace(/^!/, "")),
}));

function matches(file) {
  return RULES.reduce((included, rule) => (rule.glob.test(file) ? !rule.exclude : included), false);
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
