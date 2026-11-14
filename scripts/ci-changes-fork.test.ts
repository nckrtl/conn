// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import { expect, it } from "vite-plus/test";

import { decide, FORK_FILE_DEPS, readWorkspace } from "../.github/scripts/ci-changes.cjs";

const root = NodePath.resolve(import.meta.dirname, "..");
const runtimeDir = NodePath.join(root, "packages/client-runtime");
const runtimeExports: Record<string, { default: string }> = JSON.parse(
  NodeFS.readFileSync(NodePath.join(runtimeDir, "package.json"), "utf8"),
).exports;
const SPECIFIER = /(?:from|import)\s*\(?\s*["']([^"']+)["']/g;

function sourceFiles(dir: string): Array<string> {
  return NodeFS.readdirSync(dir, { recursive: true, encoding: "utf8" })
    .filter(
      (file) => /\.(ts|tsx|mts)$/.test(file) && !file.split(NodePath.sep).includes("node_modules"),
    )
    .map((file) => NodePath.join(dir, file));
}

function resolveRuntimeImport(from: string, specifier: string): string | null {
  if (specifier.startsWith("@t3tools/client-runtime")) {
    const entry = runtimeExports[`.${specifier.slice("@t3tools/client-runtime".length)}`];
    if (!entry)
      throw new Error(`${from} imports ${specifier}, which client-runtime does not export`);
    return NodePath.join(runtimeDir, entry.default);
  }
  if (!specifier.startsWith(".")) return null;
  const base = NodePath.resolve(NodePath.dirname(from), specifier);
  // TypeScript resolves "./x.js" to x.ts.
  const sourceBase = base.replace(/\.(m?)js(x?)$/, ".$1ts$2");
  const file = [
    base,
    sourceBase,
    `${base}.ts`,
    `${base}.tsx`,
    NodePath.join(base, "index.ts"),
  ].find((candidate) => NodeFS.existsSync(candidate) && NodeFS.statSync(candidate).isFile());
  const inRuntime = (path: string) => path.startsWith(`${runtimeDir}${NodePath.sep}`);
  if (!file && (inRuntime(base) || inRuntime(from))) {
    throw new Error(`${from} imports ${specifier}, which this test cannot resolve`);
  }
  return file && inRuntime(file) ? file : null;
}

function workspaceDeps(dir: string): Array<string> {
  const manifest = JSON.parse(
    NodeFS.readFileSync(NodePath.join(root, dir, "package.json"), "utf8"),
  );
  const deps = {
    ...manifest.dependencies,
    ...manifest.devDependencies,
    ...manifest.peerDependencies,
  };
  return Object.keys(deps).filter((name) => String(deps[name]).startsWith("workspace:"));
}

it("lists every client-runtime file the server can import", () => {
  const reached = new Set<string>();
  const visit = (from: string, source: string) => {
    for (const [, specifier] of source.matchAll(SPECIFIER)) {
      const file = specifier && resolveRuntimeImport(from, specifier);
      if (!file || reached.has(file)) continue;
      reached.add(file);
      visit(file, NodeFS.readFileSync(file, "utf8"));
    }
  };
  for (const file of sourceFiles(NodePath.join(root, "apps/server"))) {
    visit(file, NodeFS.readFileSync(file, "utf8"));
  }

  const pattern = FORK_FILE_DEPS.t3?.["@t3tools/client-runtime"];
  const relative = [...reached].map((file) =>
    NodePath.relative(root, file).split(NodePath.sep).join("/"),
  );
  expect(relative.length).toBeGreaterThan(0);
  expect(relative.filter((file) => !pattern?.test(file))).toEqual([]);
});

it("runs the server shards only for the client-runtime files the server imports", () => {
  const packages = readWorkspace();
  const runsServer = (file: string) => decide([file], packages, false).outputs.test_server;
  expect(runsServer("packages/client-runtime/src/orbitGateway/threadStart.ts")).toBe(false);
  expect(runsServer("packages/client-runtime/src/orbitGateway/client.ts")).toBe(true);
  expect(runsServer("packages/client-runtime/package.json")).toBe(true);
});

it("keeps client-runtime's workspace dependencies within the server's", () => {
  // The server-to-client-runtime edge is file-level, so a package only client-runtime
  // used could change the four files without reaching the server.
  const server = new Set(workspaceDeps("apps/server"));
  expect(workspaceDeps("packages/client-runtime").filter((name) => !server.has(name))).toEqual([]);
});

it("runs Rust and Release Smoke only for the files they read, except on main pushes", () => {
  const packages = readWorkspace();
  const jobs = (file: string, full = false) => {
    const { rust, release_smoke } = decide([file], packages, full).outputs;
    return { rust, release_smoke };
  };
  expect(jobs(".github/workflows/ci.yml")).toEqual({ rust: false, release_smoke: false });
  expect(jobs("apps/web/package.json")).toEqual({ rust: false, release_smoke: true });
  expect(jobs("scripts/release-smoke.ts")).toEqual({ rust: false, release_smoke: true });
  expect(jobs("native/resource-monitor/src/main.rs").rust).toBe(true);
  expect(jobs(".github/workflows/ci.yml", true)).toEqual({ rust: true, release_smoke: true });
});
