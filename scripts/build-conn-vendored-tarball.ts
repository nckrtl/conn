#!/usr/bin/env node
// @effect-diagnostics nodeBuiltinImport:off globalConsole:off - a one-off build helper run by hand.
/**
 * Rebuilds apps/mobile/deps/<package>-*-conn.tgz from the upstream tarball,
 * then patches/<package>@*.patch, then patches/<package>-conn.patch.
 * Usage: node scripts/build-conn-vendored-tarball.ts <package> [upstream.tgz]
 */
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

const repoRoot = NodePath.resolve(import.meta.dirname, "..");
const depsDir = NodePath.join(repoRoot, "apps/mobile/deps");
const packageArg = process.argv[2];
if (!packageArg) throw new Error("Pass the package name, e.g. react-native-screens.");
const packageName: string = packageArg;
const patchFile = NodePath.join(repoRoot, `patches/${packageName}-conn.patch`);

function upstreamTarball(): string {
  const explicit = process.argv[3];
  if (explicit) return NodePath.resolve(explicit);
  const candidates = NodeFS.readdirSync(depsDir).filter(
    (name) =>
      name.startsWith(`${packageName}-`) &&
      /^\d/.test(name.slice(packageName.length + 1)) &&
      name.endsWith(".tgz") &&
      !name.endsWith("-conn.tgz"),
  );
  if (candidates.length !== 1) {
    throw new Error(
      `Expected one upstream ${packageName} tarball in ${depsDir}, found: ${candidates.join(", ") || "none"}. Pass its path.`,
    );
  }
  return NodePath.join(depsDir, candidates[0]!);
}

const source = upstreamTarball();
const work = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), `conn-${packageName}-`));
try {
  NodeChildProcess.execFileSync("tar", ["-xzf", source, "-C", work]);
  const packageDir = NodePath.join(work, "package");
  // Upstream may also ship versioned pnpm patches for this package. Those
  // cannot target Conn's rebuilt -conn.tgz, so apply them here first.
  const patchesDir = NodePath.join(repoRoot, "patches");
  const upstreamPatches = NodeFS.readdirSync(patchesDir)
    .filter((name) => name.startsWith(`${packageName}@`) && name.endsWith(".patch"))
    .sort();
  // --forward refuses an already-applied hunk; any rejected hunk fails the build.
  for (const name of [...upstreamPatches, NodePath.basename(patchFile)]) {
    NodeChildProcess.execFileSync(
      "patch",
      [
        "-p1",
        "--forward",
        "--batch",
        "--no-backup-if-mismatch",
        "-i",
        NodePath.join(patchesDir, name),
      ],
      {
        cwd: packageDir,
        stdio: "inherit",
      },
    );
  }

  const manifestPath = NodePath.join(packageDir, "package.json");
  const manifest = JSON.parse(NodeFS.readFileSync(manifestPath, "utf8")) as { version: string };
  manifest.version = `${manifest.version}-conn`;
  NodeFS.writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);

  // Name it after upstream's tarball so a new upstream build (upstream adds a
  // source-commit suffix instead of bumping the version) gets a new path too.
  const output = NodePath.join(depsDir, NodePath.basename(source).replace(/\.tgz$/, "-conn.tgz"));
  // COPYFILE_DISABLE keeps macOS bsdtar from adding ._ metadata entries.
  NodeChildProcess.execFileSync("tar", ["-czf", output, "-C", work, "package"], {
    env: { ...process.env, COPYFILE_DISABLE: "1" },
  });
  console.log(`Wrote ${NodePath.relative(repoRoot, output)} from ${NodePath.basename(source)}.`);
  console.log(
    `Point apps/mobile/package.json "${packageName}" at file:deps/${NodePath.basename(output)}, then run vp install.`,
  );
} finally {
  NodeFS.rmSync(work, { recursive: true, force: true });
}
