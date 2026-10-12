#!/usr/bin/env node
/**
 * Builds Conn's react-native-screens tarball: upstream's vendored tarball in
 * apps/mobile/deps with patches/react-native-screens-conn.patch applied.
 *
 * Upstream vendors react-native-screens as a tarball (`file:deps/...tgz`),
 * which pnpm patches cannot target. Conn keeps its native changes in the patch
 * file instead and ships the patched tarball next to upstream's. After an
 * upstream merge that bumps the vendored tarball, run this script again and
 * point apps/mobile/package.json at the tarball it prints (see FORK.md).
 *
 *   node scripts/build-conn-react-native-screens.ts [path/to/upstream.tgz]
 */
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

const repoRoot = NodePath.resolve(import.meta.dirname, "..");
const depsDir = NodePath.join(repoRoot, "apps/mobile/deps");
const patchFile = NodePath.join(repoRoot, "patches/react-native-screens-conn.patch");

function upstreamTarball(): string {
  const explicit = process.argv[2];
  if (explicit) return NodePath.resolve(explicit);
  const candidates = NodeFS.readdirSync(depsDir).filter(
    (name) => /^react-native-screens-.+\.tgz$/.test(name) && !name.endsWith("-conn.tgz"),
  );
  if (candidates.length !== 1) {
    throw new Error(
      `Expected one upstream react-native-screens tarball in ${depsDir}, found: ${candidates.join(", ") || "none"}. Pass its path.`,
    );
  }
  return NodePath.join(depsDir, candidates[0]!);
}

const source = upstreamTarball();
const work = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "conn-rns-"));
try {
  NodeChildProcess.execFileSync("tar", ["-xzf", source, "-C", work]);
  const packageDir = NodePath.join(work, "package");
  // --forward refuses an already-applied hunk; any rejected hunk fails the build.
  NodeChildProcess.execFileSync(
    "patch",
    ["-p1", "--forward", "--batch", "--no-backup-if-mismatch", "-i", patchFile],
    {
      cwd: packageDir,
      stdio: "inherit",
    },
  );

  const manifestPath = NodePath.join(packageDir, "package.json");
  const manifest = JSON.parse(NodeFS.readFileSync(manifestPath, "utf8")) as { version: string };
  manifest.version = `${manifest.version}-conn`;
  NodeFS.writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);

  const output = NodePath.join(depsDir, `react-native-screens-${manifest.version}.tgz`);
  // COPYFILE_DISABLE keeps macOS bsdtar from adding ._ metadata entries.
  NodeChildProcess.execFileSync("tar", ["-czf", output, "-C", work, "package"], {
    env: { ...process.env, COPYFILE_DISABLE: "1" },
  });
  console.log(`Wrote ${NodePath.relative(repoRoot, output)} from ${NodePath.basename(source)}.`);
  console.log(
    `Point apps/mobile/package.json "react-native-screens" at file:deps/${NodePath.basename(output)}, then run vp install.`,
  );
} finally {
  NodeFS.rmSync(work, { recursive: true, force: true });
}
