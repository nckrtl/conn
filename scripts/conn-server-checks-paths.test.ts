// @effect-diagnostics nodeBuiltinImport:off
// The Conn Server checks (.github/workflows/conn-server-checks.yml) run only when a change touches
// a file they read (PATHS in .github/scripts/conn-server-checks-paths.cjs). This test finds those
// files: the monorepo paths and workspace packages the checks' tools name, apps/server (the tools
// start the T3 server from source and run its tests), the packages `vp i` builds, the tarballs
// pnpm-lock.yaml installs, and every file those import or read, transitively.
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import { expect, it } from "vite-plus/test";

import { matches } from "../.github/scripts/conn-server-checks-paths.cjs";
import { decide, readWorkspace as readCiWorkspace } from "../.github/scripts/ci-changes.cjs";

const root = NodePath.resolve(import.meta.dirname, "..");
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
// A data file a module reads by name: `readFileSync(join(root, ".task-cache.json"))`.
const DATA_FILE =
  /["'`](\.?[\w.-]*[\w-]\.(?:json|jsonc|ya?ml|txt|graphql|sql|html|css|toml|ndjson))["'`]/g;
const READS_FILES = /\b(readFileSync|readFile|existsSync|createReadStream|join|resolve)\s*\(/;
// Data file names the server uses for a user's project, not for this repository.
const PROJECT_FILES = new Set(["t3.json"]);
const INSTALL_SCRIPTS = ["preinstall", "install", "postinstall", "prepare"];

// Hand-run tools that name monorepo folders no check reads. A test keeps them out of
// tools/check.sh and out of every file the checks run.
const NOT_RUN_BY_CHECKS = [
  "apps/conn-server/tools/bump-report.mjs",
  "apps/server/scripts/mobile-lab-seed.ts",
];

const posix = (file: string) => NodePath.relative(root, file).split(NodePath.sep).join("/");
const isFile = (file: string) => NodeFS.existsSync(file) && NodeFS.statSync(file).isFile();
const isDir = (file: string) => NodeFS.existsSync(file) && NodeFS.statSync(file).isDirectory();
const readJson = (file: string) => JSON.parse(NodeFS.readFileSync(file, "utf8"));

// CI checks out tracked files only.
const tracked = new Set(
  NodeChildProcess.execFileSync("git", ["ls-files", "-z"], {
    cwd: root,
    encoding: "utf8",
    maxBuffer: 256 * 1024 * 1024,
  })
    .split("\0")
    .filter((file) => file && !file.startsWith(".repos/"))
    .map((file) => NodePath.join(root, file)),
);
const isTracked = (file: string) => tracked.has(file) && isFile(file);
function filesUnder(dir: string): Array<string> {
  const prefix = `${dir}${NodePath.sep}`;
  return [...tracked].filter((file) => file.startsWith(prefix) && isFile(file));
}

type Package = { dir: string; exports: Record<string, unknown>; scripts: Record<string, string> };

const workspace = new Map<string, Package>();
for (const parent of ["apps", "packages", "infra"]) {
  for (const name of NodeFS.readdirSync(NodePath.join(root, parent))) {
    const dir = NodePath.join(root, parent, name);
    const manifest = NodePath.join(dir, "package.json");
    if (!isTracked(manifest)) continue;
    const json = readJson(manifest);
    workspace.set(json.name, { dir, exports: json.exports ?? {}, scripts: json.scripts ?? {} });
  }
}
const PACKAGE_NAME = new RegExp(
  `["'\`]((?:${[...workspace.keys()].map((name) => name.replace(/[.+^$()|[\]\\]/g, "\\$&")).join("|")})(?:/[\\w./-]+)?)["'\`]`,
  "g",
);

function exportTarget(entry: unknown): string | null {
  if (typeof entry === "string") return entry;
  if (entry && typeof entry === "object") {
    const conditions = entry as Record<string, unknown>;
    return exportTarget(conditions.import ?? conditions.default ?? conditions.node);
  }
  return null;
}

/** The monorepo files a specifier loads; [] for a package from the registry. */
function resolveSpecifier(from: string, specifier: string): Array<string> {
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
  const target = exportTarget(pkg.exports[`.${specifier.slice(name.length)}`]);
  // A subpath the manifest does not export: count the whole package.
  if (!target) return filesUnder(pkg.dir);
  return [NodePath.join(pkg.dir, target), NodePath.join(pkg.dir, "package.json")];
}

/**
 * The monorepo files a tool's source names: paths (`importSource("packages/x/src/y.ts")`) and
 * workspace packages, however it loads them (`packageImporter("apps/server")("@t3tools/x/y")`).
 */
function toolReferences(source: string): Array<string> {
  const files: Array<string> = [];
  for (const [, path] of source.matchAll(MONOREPO_PATH)) {
    if (path!.split("/").includes("node_modules")) continue;
    // A path a tool builds (`packages/x/src/${name}.ts`) counts as its whole folder.
    let target = NodePath.join(root, path!);
    while (!isFile(target) && !isDir(target)) target = NodePath.dirname(target);
    if (posix(target).split("/").length < 2) continue;
    // A package root names where to resolve from (`packageImporter("packages/shared")`),
    // not files to read; what it then loads is a package specifier, followed below.
    const manifest = NodePath.join(target, "package.json");
    if (isDir(target) && isFile(manifest)) files.push(manifest);
    else files.push(...(isDir(target) ? filesUnder(target) : [target]));
  }
  for (const [, specifier] of source.matchAll(PACKAGE_NAME)) {
    files.push(...resolveSpecifier(root, specifier!));
  }
  return files;
}

/** Tracked data files a module opens by name, next to it, in its package or at the root. */
function dataFiles(file: string, source: string): Array<string> {
  const owner = [...workspace.values()].find((pkg) => file.startsWith(`${pkg.dir}${NodePath.sep}`));
  const bases = [NodePath.dirname(file), owner?.dir, root].filter((dir) => dir !== undefined);
  return source
    .split("\n")
    .filter((line) => READS_FILES.test(line))
    .flatMap((line) => [...line.matchAll(DATA_FILE)].map(([, name]) => name!))
    .filter((name) => !PROJECT_FILES.has(name))
    .flatMap((name) => bases.map((base) => NodePath.join(base, name)))
    .filter(isTracked);
}

/** Root-relative `file:` dependencies in pnpm-lock.yaml. `link:` ones are workspace symlinks. */
function lockfileLocalDependencies(): Array<string> {
  const lockfile = NodeFS.readFileSync(NodePath.join(root, "pnpm-lock.yaml"), "utf8");
  const paths = new Set<string>();
  for (const [, path] of lockfile.matchAll(/\bfile:([\w./@+-]+?)(?=[\s:'"(),}]|$)/gm)) {
    const target = NodePath.join(root, path!);
    if (isTracked(target) || isDir(target)) paths.add(posix(target));
  }
  return [...paths].sort();
}

function checkedFiles(): Set<string> {
  const seeds: Array<string> = [];
  for (const file of filesUnder(NodePath.join(root, "apps/conn-server"))) {
    if (!TOOL_SOURCE.test(file)) continue;
    if (CODE.test(file)) seeds.push(file);
    seeds.push(...toolReferences(NodeFS.readFileSync(file, "utf8")));
  }
  seeds.push(...filesUnder(NodePath.join(root, "apps/server")));
  // `vp i` runs workspace install scripts (annotation-overlay's `prepare` builds it). The root
  // `prepare` only configures git hooks.
  for (const pkg of workspace.values()) {
    if (INSTALL_SCRIPTS.some((name) => pkg.scripts[name])) seeds.push(...filesUnder(pkg.dir));
  }
  for (const path of lockfileLocalDependencies()) {
    const target = NodePath.join(root, path);
    if (isFile(target)) seeds.push(target);
    else {
      seeds.push(NodePath.join(target, "package.json"));
      const scripts = readJson(NodePath.join(target, "package.json")).scripts ?? {};
      if (INSTALL_SCRIPTS.some((name) => scripts[name])) seeds.push(...filesUnder(target));
    }
  }

  const notRun = new Set(NOT_RUN_BY_CHECKS.map((file) => NodePath.join(root, file)));
  const reached = new Set<string>();
  const queue = seeds.filter((file) => !notRun.has(file));
  while (queue.length > 0) {
    const file = queue.pop()!;
    if (reached.has(file)) continue;
    reached.add(file);
    if (!CODE.test(file)) continue;
    const source = NodeFS.readFileSync(file, "utf8");
    const next = dataFiles(file, source);
    for (const pattern of SPECIFIERS) {
      for (const [, specifier] of source.matchAll(pattern)) {
        next.push(...resolveSpecifier(file, specifier!));
      }
    }
    for (const found of next) if (!reached.has(found)) queue.push(found);
  }
  return new Set([...reached].map(posix));
}

const files = checkedFiles();

it("runs the Conn Server checks for every monorepo file they read", () => {
  expect(files.size).toBeGreaterThan(1000);
  expect([...files].filter((file) => !matches(file)).sort()).toEqual([]);
});

it("follows packages a tool loads through a package importer", () => {
  const reached = toolReferences(
    'const server = packageImporter("apps/server");\n' +
      'await server("@t3tools/client-runtime/pull-request-diff-fold");',
  ).map(posix);
  expect(reached).toContain("packages/client-runtime/src/pullRequestDiffFold.ts");
  expect(matches("packages/client-runtime/src/pullRequestDiffFold.ts")).toBe(false);
});

it("follows data files a reached module reads", () => {
  expect(files.has(".task-cache.json")).toBe(true);
});

it("covers the tarballs pnpm-lock.yaml installs", () => {
  const local = lockfileLocalDependencies();
  expect(local).toContain("apps/mobile/deps/react-native-screens-5.0.0-t3.61-conn.tgz");
  for (const path of local) {
    expect(files.has(isFile(NodePath.join(root, path)) ? path : `${path}/package.json`)).toBe(true);
  }
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
  "packages/annotation-overlay/src/inject.ts",
  "patches/electron-updater@6.8.9.patch",
  "tsconfig.base.json",
  "apps/conn-server/helpers/sdk-host/package-lock.json",
  // tools/check.sh reads the Rust toolchain pin from these three.
  ".github/workflows/conn-server-checks.yml",
  ".github/workflows/conn-server-ci.yml",
  ".github/workflows/conn-server-release.yml",
])("runs the Conn Server checks when %s changes", (file) => {
  expect(matches(file)).toBe(true);
});

it.each([
  "packages/client-runtime/src/orbitGateway/threadStart.ts",
  "apps/web/src/main.tsx",
  "apps/mobile/src/app/_layout.tsx",
  "apps/desktop/src/main.ts",
])("skips the Conn Server checks when only %s changes", (file) => {
  expect(matches(file)).toBe(false);
});

it.each([
  "apps/conn-server/crates/conn-engine/tools/client-check.mjs",
  ".github/workflows/conn-server-checks.yml",
  ".github/scripts/conn-server-checks-paths.cjs",
])("runs this test in CI when %s changes", (file) => {
  expect(decide([file], readCiWorkspace(), false).outputs).toMatchObject({
    test_packages: "@t3tools/scripts",
    release_smoke: false,
  });
});
