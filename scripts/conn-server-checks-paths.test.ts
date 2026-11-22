// @effect-diagnostics nodeBuiltinImport:off
// The Conn Server checks (.github/workflows/conn-server-checks.yml) run only when a change touches
// a file they read (PATHS in .github/scripts/conn-server-checks-paths.cjs). This test finds those
// files: the monorepo paths and workspace packages the checks' tools name, apps/server (the tools
// start the T3 server from source and run its tests), the packages `vp i` builds, the tarballs
// pnpm-lock.yaml installs, and every file those import or read, transitively.
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { expect, it } from "vite-plus/test";

import {
  ANCESTOR_DIRS,
  matches,
  PATHS,
  readByName,
} from "../.github/scripts/conn-server-checks-paths.cjs";
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

// Files a test adds on top of the checkout, as absolute path → contents.
const overlay = new Map<string, string>();
const posix = (file: string) => NodePath.relative(root, file).split(NodePath.sep).join("/");
const isFile = (file: string) =>
  overlay.has(file) || (NodeFS.existsSync(file) && NodeFS.statSync(file).isFile());
const isDir = (file: string) => NodeFS.existsSync(file) && NodeFS.statSync(file).isDirectory();
const readText = (file: string) => overlay.get(file) ?? NodeFS.readFileSync(file, "utf8");
const readJson = (file: string) => JSON.parse(readText(file));

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
const isTracked = (file: string) => overlay.has(file) || (tracked.has(file) && isFile(file));
const allFiles = () => [...tracked, ...overlay.keys()];
function filesUnder(dir: string): Array<string> {
  const prefix = `${dir}${NodePath.sep}`;
  return allFiles().filter((file) => file.startsWith(prefix) && isFile(file));
}

type Package = {
  dir: string;
  exports: Record<string, unknown> | string;
  scripts: Record<string, string>;
};

// Every package pnpm-workspace.yaml lists, as `vp i` installs them.
const workspace = new Map<string, Package>();
for (const { dir } of readCiWorkspace()) {
  const json = readJson(NodePath.join(root, dir, "package.json"));
  workspace.set(json.name, {
    dir: NodePath.join(root, dir),
    exports: json.exports ?? {},
    scripts: json.scripts ?? {},
  });
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

const EXTENSIONS = [".ts", ".tsx", ".mts", ".cts", ".js", ".jsx", ".mjs", ".cjs", ".json"];

/** A package folder's entry, from `exports["."]`, then `main`, then `index.*`. */
function packageEntry(dir: string): string | undefined {
  const manifest = NodePath.join(dir, "package.json");
  if (isFile(manifest)) {
    const json = readJson(manifest);
    const exported = exportTarget(
      typeof json.exports === "string" ? json.exports : json.exports?.["."],
    );
    for (const entry of [exported, json.main]) {
      const file = typeof entry === "string" && resolvePath(NodePath.join(dir, entry));
      if (file) return file;
    }
  }
  return EXTENSIONS.map((extension) => NodePath.join(dir, `index${extension}`)).find(isFile);
}

/** Node and TypeScript resolution of a path: exact, `.js` → `.ts`, extensions, then folder. */
function resolvePath(base: string): string | undefined {
  if (isFile(base)) return base;
  const source = base.replace(/\.(m|c)?js(x?)$/, (_, kind = "", x) => `.${kind}ts${x}`);
  if (source !== base && isFile(source)) return source;
  const withExtension = EXTENSIONS.map((extension) => `${base}${extension}`).find(isFile);
  if (withExtension) return withExtension;
  return isDir(base) ||
    [...overlay.keys()].some((file) => file.startsWith(`${base}${NodePath.sep}`))
    ? packageEntry(base)
    : undefined;
}

/** The monorepo files a specifier loads; [] for a package from the registry. */
function resolveSpecifier(from: string, specifier: string): Array<string> {
  if (specifier.startsWith(".")) {
    const file = resolvePath(NodePath.resolve(NodePath.dirname(from), specifier));
    // No file: a specifier inside a string or a fixture, so there is nothing to read.
    if (!file) return [];
    const manifest = NodePath.join(NodePath.dirname(file), "package.json");
    return isFile(manifest) && file !== manifest ? [file, manifest] : [file];
  }
  const parts = specifier.split("/");
  const name = specifier.startsWith("@") ? parts.slice(0, 2).join("/") : parts[0]!;
  const pkg = workspace.get(name);
  if (!pkg) return [];
  const subpath = `.${specifier.slice(name.length)}`;
  const { exports } = pkg;
  const exported = typeof exports === "string" ? { ".": exports } : exports;
  const target = exportTarget(exported[subpath]);
  const file = target
    ? resolvePath(NodePath.join(pkg.dir, target))
    : subpath === "." && Object.keys(exported).length === 0
      ? packageEntry(pkg.dir)
      : undefined;
  // A subpath this test cannot resolve: count the whole package.
  if (!file) return filesUnder(pkg.dir);
  return [file, NodePath.join(pkg.dir, "package.json")];
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
    seeds.push(...toolReferences(readText(file)));
  }
  seeds.push(...filesUnder(NodePath.join(root, "apps/server")));
  // Config the ancestor rule selects runs when a tool finds it (postcss.config.cjs), so the
  // walk follows its imports too.
  seeds.push(
    ...allFiles().filter((file) => {
      const relative = posix(file);
      const dir = NodePath.posix.dirname(relative);
      return CODE.test(file) && ANCESTOR_DIRS.has(dir === "." ? "" : dir) && matches(relative);
    }),
  );
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
    const source = readText(file);
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

it("follows imports of config found in a folder above the checked files", () => {
  overlay.set(
    NodePath.join(root, "postcss.config.cjs"),
    'module.exports = require("./postcss-plugins.cjs");',
  );
  overlay.set(NodePath.join(root, "postcss-plugins.cjs"), "module.exports = {};");
  try {
    const reached = checkedFiles();
    expect(reached.has("postcss.config.cjs")).toBe(true);
    expect(reached.has("postcss-plugins.cjs")).toBe(true);
    // So the first test would fail until the helper is selected.
    expect(matches("postcss-plugins.cjs")).toBe(false);
  } finally {
    overlay.clear();
  }
});

it.each([
  ["an extensionless require of a .js file", "./postcss-plugins", "postcss-plugins.js"],
  ["a .js specifier of a .ts file", "./postcss-plugins.js", "postcss-plugins.ts"],
  ["a folder's index", "./postcss-plugins", "postcss-plugins/index.mjs"],
  ["a folder's package.json main", "./postcss-plugins", "postcss-plugins/lib/main.cjs"],
])("follows %s from ancestor config", (_, specifier, helper) => {
  overlay.set(
    NodePath.join(root, "postcss.config.cjs"),
    `module.exports = require("${specifier}");`,
  );
  overlay.set(NodePath.join(root, helper), "module.exports = {};");
  if (helper.endsWith("main.cjs")) {
    overlay.set(NodePath.join(root, "postcss-plugins/package.json"), '{ "main": "lib/main.cjs" }');
  }
  try {
    expect(checkedFiles().has(helper)).toBe(true);
  } finally {
    overlay.clear();
  }
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

// Tools find config by walking up from the files they read, whatever its name.
it("runs for any config file in a folder above a file the checks read", () => {
  const folders = new Set<string>();
  for (const file of files) {
    if (readByName(file)) continue;
    for (let dir = NodePath.posix.dirname(file); ; dir = NodePath.posix.dirname(dir)) {
      folders.add(dir === "." ? "" : `${dir}/`);
      if (dir === ".") break;
    }
  }
  const configs = [
    "rustfmt.toml",
    "clippy.toml",
    "postcss.config.cjs",
    "babel.config.js",
    "tsconfig.json",
    ".browserslistrc",
    ".editorconfig",
    ".gitattributes",
    ".npmrc",
    ".cargo/config.toml",
  ];
  const missed = [...folders].flatMap((dir) =>
    configs.map((name) => `${dir}${name}`).filter((file) => !matches(file)),
  );
  expect(missed).toEqual([]);
});

it("runs for .gitattributes above any file the checks read, even by name", () => {
  const missed = new Set<string>();
  const named = PATHS.filter((path) => !/[*?!]/.test(path));
  for (const file of [...files, ...named]) {
    for (let dir = NodePath.posix.dirname(file); ; dir = NodePath.posix.dirname(dir)) {
      const attributes = dir === "." ? ".gitattributes" : `${dir}/.gitattributes`;
      if (!matches(attributes)) missed.add(attributes);
      if (dir === ".") break;
    }
  }
  expect([...missed]).toEqual([]);
  expect(matches(".github/workflows/.gitattributes")).toBe(true);
  expect(matches("apps/mobile/deps/.gitattributes")).toBe(true);
});

it("keeps ancestor folders' other files and folders out", () => {
  for (const dir of ANCESTOR_DIRS) expect(dir.startsWith(".repos")).toBe(false);
  expect(matches("packages/client-runtime/src/orbitGateway/threadStart.ts")).toBe(false);
  expect(matches("packages/client-runtime/src/pullRequestDiffFold.ts")).toBe(false);
  expect(matches("README.md")).toBe(false);
  expect(matches("apps/mobile/app.config.ts")).toBe(false);
  expect(matches(".github/workflows/ci.yml")).toBe(false);
});

it("reads the workspace from pnpm-workspace.yaml", () => {
  expect([...workspace.values()].map((pkg) => posix(pkg.dir))).toContain("scripts");
});

it("leaves .repos out, as every job's checkout does", () => {
  expect(PATHS.at(-1)).toBe("!.repos/**");
  expect(matches(".repos/effect/package.json")).toBe(false);
  const workflow = NodeFS.readFileSync(
    NodePath.join(root, ".github/workflows/conn-server-checks.yml"),
    "utf8",
  );
  const fullCheckouts = workflow.match(/sparse-checkout: \|\n\s+\/\*\n/g) ?? [];
  expect(fullCheckouts.length).toBeGreaterThan(0);
  expect(workflow.match(/sparse-checkout: \|\n\s+\/\*\n\s+!\/\.repos\/\n/g)).toHaveLength(
    fullCheckouts.length,
  );
});

it.each([
  "apps/conn-server/fixtures/sessions/café.ndjson",
  'apps/conn-server/fixtures/sessions/a\n"b.ndjson',
])("selects from git's NUL-separated diff when a PR adds only %j", (name) => {
  const repo = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "conn-server-checks-paths-"));
  try {
    const git = (...args: Array<string>) =>
      NodeChildProcess.execFileSync(
        "git",
        ["-C", repo, "-c", "user.name=t", "-c", "user.email=t@t", ...args],
        { encoding: "utf8" },
      );
    git("init", "-q");
    git("commit", "-q", "--allow-empty", "-m", "base");
    NodeFS.mkdirSync(NodePath.join(repo, NodePath.dirname(name)), { recursive: true });
    NodeFS.writeFileSync(NodePath.join(repo, name), "");
    // Listed first, so a list split on the wrong separator starts with a file no check reads.
    NodeFS.writeFileSync(NodePath.join(repo, "a.md"), "");
    git("add", "-A");
    git("commit", "-q", "-m", "change");
    // The diff the workflow's Detect step takes.
    const workflow = NodeFS.readFileSync(
      NodePath.join(root, ".github/workflows/conn-server-checks.yml"),
      "utf8",
    );
    const diff = workflow
      .match(/git (diff [^"\n]+) "\$base" HEAD/)![1]!
      .trim()
      .split(/\s+/);
    const list = NodePath.join(repo, "..", `${NodePath.basename(repo)}.paths`);
    NodeFS.writeFileSync(list, git(...diff, "HEAD^1", "HEAD"));
    const output = NodeChildProcess.execFileSync(
      process.execPath,
      [NodePath.join(root, ".github/scripts/conn-server-checks-paths.cjs"), list],
      { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] },
    );
    NodeFS.rmSync(list);
    expect(output).toBe("run=true\n");
  } finally {
    NodeFS.rmSync(repo, { recursive: true, force: true });
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
  "rustfmt.toml",
  "postcss.config.cjs",
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
