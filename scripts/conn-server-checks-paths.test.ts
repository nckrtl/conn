// @effect-diagnostics nodeBuiltinImport:off
// The Conn Server checks (.github/workflows/conn-server-checks.yml) run only when a PR touches
// a file they read. This test finds those files: the monorepo paths the checks' tools name,
// apps/server (the tools start the T3 server from source and run its tests), and every file
// those import, transitively. It fails when the workflow's `paths` miss one.
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import { expect, it } from "vite-plus/test";

import { decide, readWorkspace as readCiWorkspace } from "../.github/scripts/ci-changes.cjs";

const root = NodePath.resolve(import.meta.dirname, "..");
const WORKFLOW = ".github/workflows/conn-server-checks.yml";
const CODE = /\.(ts|tsx|mts|cts|js|mjs|cjs)$/;
// Code and scripts in apps/conn-server that name monorepo paths. Rust reads none.
const TOOL_SOURCE = /\.(mjs|cjs|js|ts|sh|py)$/;
const MONOREPO_PATH = /(?<![\w.-])((?:apps|packages|scripts|infra)\/[\w.-]+(?:\/[\w.-]+)*)/g;
// Type-only imports are erased before the code runs, so they read nothing.
const SPECIFIERS = [
  /^\s*(?:import|export)\s+(?!type\s)[^;]*?\bfrom\s*["']([^"']+)["']/gm,
  /^\s*import\s*["']([^"']+)["']/gm,
  /\bimport\s*\(\s*["']([^"']+)["']\s*\)/g,
  /\brequire(?:\.resolve)?\s*\(\s*["']([^"']+)["']\s*\)/g,
];

// Hand-run tools that name monorepo folders no check reads. The last test keeps them out of
// tools/check.sh and out of every file the checks run.
const NOT_RUN_BY_CHECKS = [
  "apps/conn-server/tools/bump-report.mjs",
  "apps/server/scripts/mobile-lab-seed.ts",
];

const posix = (file: string) => NodePath.relative(root, file).split(NodePath.sep).join("/");
const isFile = (file: string) => NodeFS.existsSync(file) && NodeFS.statSync(file).isFile();
const isDir = (file: string) => NodeFS.existsSync(file) && NodeFS.statSync(file).isDirectory();

// CI checks out tracked files only.
let tracked: Array<string> | undefined;
function filesUnder(dir: string): Array<string> {
  tracked ??= NodeChildProcess.execFileSync(
    "git",
    ["ls-files", "-z", "--", "apps", "packages", "infra", "scripts"],
    { cwd: root, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 },
  )
    .split("\0")
    .filter(Boolean)
    .map((file) => NodePath.join(root, file));
  const prefix = `${dir}${NodePath.sep}`;
  return tracked.filter((file) => file.startsWith(prefix) && isFile(file));
}

type Workspace = Map<string, { dir: string; exports: Record<string, unknown> }>;

function readWorkspace(): Workspace {
  const packages: Workspace = new Map();
  for (const parent of ["apps", "packages", "infra"]) {
    for (const name of NodeFS.readdirSync(NodePath.join(root, parent))) {
      const dir = NodePath.join(root, parent, name);
      const manifest = NodePath.join(dir, "package.json");
      if (!isFile(manifest)) continue;
      const json = JSON.parse(NodeFS.readFileSync(manifest, "utf8"));
      packages.set(json.name, { dir, exports: json.exports ?? {} });
    }
  }
  return packages;
}

function exportTarget(entry: unknown): string | null {
  if (typeof entry === "string") return entry;
  if (entry && typeof entry === "object") {
    const conditions = entry as Record<string, unknown>;
    return exportTarget(conditions.import ?? conditions.default ?? conditions.node);
  }
  return null;
}

/** The monorepo files a specifier loads; [] for a package from the registry. */
function resolveSpecifier(from: string, specifier: string, workspace: Workspace): Array<string> {
  if (specifier.startsWith(".")) {
    const base = NodePath.resolve(NodePath.dirname(from), specifier);
    // TypeScript resolves "./x.js" to x.ts.
    const sourceBase = base.replace(/\.(m?)js(x?)$/, ".$1ts$2");
    const file = [
      base,
      sourceBase,
      `${base}.ts`,
      `${base}.tsx`,
      NodePath.join(base, "index.ts"),
    ].find(isFile);
    // No file: a specifier inside a string or a fixture, so there is nothing to read.
    return file ? [file] : [];
  }
  const parts = specifier.split("/");
  const name = specifier.startsWith("@") ? parts.slice(0, 2).join("/") : parts[0]!;
  const pkg = workspace.get(name);
  if (!pkg) return [];
  const subpath = `.${specifier.slice(name.length)}`;
  const target = exportTarget(pkg.exports[subpath]);
  // A subpath the manifest does not export: count the whole package.
  if (!target) return filesUnder(pkg.dir);
  return [NodePath.join(pkg.dir, target), NodePath.join(pkg.dir, "package.json")];
}

function checkedFiles(): Set<string> {
  const workspace = readWorkspace();
  const seeds: Array<string> = [];
  const notRun = new Set(NOT_RUN_BY_CHECKS.map((file) => NodePath.join(root, file)));
  for (const file of filesUnder(NodePath.join(root, "apps/conn-server"))) {
    if (!TOOL_SOURCE.test(file) || notRun.has(file)) continue;
    if (CODE.test(file)) seeds.push(file);
    for (const [, path] of NodeFS.readFileSync(file, "utf8").matchAll(MONOREPO_PATH)) {
      if (path!.split("/").includes("node_modules")) continue;
      // A path a tool builds (`packages/x/src/${name}.ts`) counts as its whole folder.
      let target = NodePath.join(root, path!);
      while (!isFile(target) && !isDir(target)) target = NodePath.dirname(target);
      if (posix(target).split("/").length < 2) continue;
      // A package root names where to resolve from (`packageImporter("packages/shared")`),
      // not files to read; what it then imports is followed below.
      const manifest = NodePath.join(target, "package.json");
      if (isDir(target) && isFile(manifest)) seeds.push(manifest);
      else seeds.push(...(isDir(target) ? filesUnder(target) : [target]));
    }
  }
  seeds.push(...filesUnder(NodePath.join(root, "apps/server")));

  const reached = new Set<string>();
  const queue = seeds.filter((file) => !notRun.has(file));
  while (queue.length > 0) {
    const file = queue.pop()!;
    if (reached.has(file)) continue;
    reached.add(file);
    if (!CODE.test(file)) continue;
    const source = NodeFS.readFileSync(file, "utf8");
    for (const pattern of SPECIFIERS) {
      for (const [, specifier] of source.matchAll(pattern)) {
        for (const next of resolveSpecifier(file, specifier!, workspace)) {
          if (!reached.has(next)) queue.push(next);
        }
      }
    }
  }
  return new Set([...reached].map(posix));
}

/** The `pull_request.paths` list (anchored as `&paths` for `push`). */
function workflowPaths(): Array<string> {
  const lines = NodeFS.readFileSync(NodePath.join(root, WORKFLOW), "utf8").split("\n");
  const start = lines.findIndex((line) => /^\s+paths: &paths\s*$/.test(line));
  expect(start).toBeGreaterThan(-1);
  const paths: Array<string> = [];
  for (const line of lines.slice(start + 1)) {
    if (/^\s+#/.test(line)) continue;
    const entry = line.match(/^\s+-\s+(["']?)([^"'\s]+)\1\s*$/);
    if (!entry) break;
    paths.push(entry[2]!);
  }
  return paths;
}

/** GitHub's path filter globs: `**` crosses folders, `*` does not. */
function globToRegExp(glob: string): RegExp {
  let pattern = "";
  for (let index = 0; index < glob.length; index++) {
    const char = glob[index]!;
    if (glob.startsWith("**/", index)) {
      pattern += "(?:.*/)?";
      index += 2;
    } else if (glob.startsWith("**", index)) {
      pattern += ".*";
      index += 1;
    } else if (char === "*") pattern += "[^/]*";
    else if (char === "?") pattern += "[^/]";
    else pattern += char.replace(/[.+^${}()|[\]\\]/g, "\\$&");
  }
  return new RegExp(`^${pattern}$`);
}

/** The last pattern that matches decides; `!` excludes. */
function matcher(): (file: string) => boolean {
  const rules = workflowPaths().map((path) => ({
    exclude: path.startsWith("!"),
    glob: globToRegExp(path.replace(/^!/, "")),
  }));
  return (file) =>
    rules.reduce((included, rule) => (rule.glob.test(file) ? !rule.exclude : included), false);
}

const files = checkedFiles();

it("runs the Conn Server checks for every monorepo file they read", () => {
  expect(files.size).toBeGreaterThan(1000);
  const matches = matcher();
  expect([...files].filter((file) => !matches(file)).sort()).toEqual([]);
});

it("leaves out only files no check runs", () => {
  const checkScript = NodeFS.readFileSync(
    NodePath.join(root, "apps/conn-server/tools/check.sh"),
    "utf8",
  );
  for (const file of NOT_RUN_BY_CHECKS) {
    expect(files.has(file)).toBe(false);
    expect(checkScript).not.toContain(NodePath.basename(file));
  }
});

it.each([
  "pnpm-lock.yaml",
  "package.json",
  "apps/web/package.json",
  "packages/client-runtime/package.json",
  "patches/electron-updater@6.8.9.patch",
  "tsconfig.base.json",
  "apps/conn-server/helpers/sdk-host/package-lock.json",
  // tools/check.sh reads the Rust toolchain pin from these three.
  WORKFLOW,
  ".github/workflows/conn-server-ci.yml",
  ".github/workflows/conn-server-release.yml",
])("runs the Conn Server checks when %s changes", (file) => {
  expect(matcher()(file)).toBe(true);
});

it.each([
  "packages/client-runtime/src/orbitGateway/threadStart.ts",
  "packages/annotation-overlay/src/inject.ts",
  "apps/web/src/main.tsx",
  "apps/mobile/src/app/_layout.tsx",
  "apps/desktop/src/main.ts",
])("skips the Conn Server checks when only %s changes", (file) => {
  expect(matcher()(file)).toBe(false);
});

it.each(["apps/conn-server/crates/conn-engine/tools/client-check.mjs", WORKFLOW])(
  "runs this test in CI when %s changes",
  (file) => {
    expect(decide([file], readCiWorkspace(), false).outputs).toMatchObject({
      test_packages: "@t3tools/scripts",
      release_smoke: false,
    });
  },
);
