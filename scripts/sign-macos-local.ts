// @effect-diagnostics nodeBuiltinImport:off globalConsole:off - Standalone signing CLI without an Effect runtime.
// rooms-patches: re-sign a built T3 Code .app with a local code-signing
// identity, for installs that do not use T3's Developer ID. It applies the
// release build's entitlements and hardened runtime, minus the team-bound
// passkey entitlements, so passkey sign-in is unavailable in such a build.
//
// Usage: node scripts/sign-macos-local.ts "<Conn.app>" [identity]
// Refuses to sign unless the artifact's full commit SHA is the tip of an origin sync/ branch.
// The identity defaults to $LOCAL_SIGNING_IDENTITY. Without either, a signing certificate
// that belongs to the fork's Apple team (src/branding/forkBrand.json, or T3CODE_APPLE_TEAM_ID) is
// used, and the signed app must then carry that team id (an identity you pass is not checked).
import * as NodeChildProcess from "node:child_process";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";

import { sign } from "@electron/osx-sign";

import { resolveForkBrand } from "../apps/desktop/src/branding/forkBrand.ts";
import { assertInstallArtifactProvenance } from "./sync-source-provenance.ts";

const run = (command: string, args: readonly string[]) =>
  NodeChildProcess.spawnSync(command, args, { encoding: "utf8" });

/** The SHA-1 of a codesigning certificate whose organizational unit is the team id. */
function findIdentityForTeam(teamId: string): string | undefined {
  const listing = run("security", ["find-identity", "-v", "-p", "codesigning"]).stdout;
  for (const match of listing.matchAll(/^\s*\d+\)\s+([0-9A-F]{40})\s+"([^"]+)"/gm)) {
    const [, hash, name] = match;
    const pem = run("security", ["find-certificate", "-c", name!, "-p"]).stdout;
    const subject = NodeChildProcess.spawnSync("openssl", ["x509", "-noout", "-subject"], {
      input: pem,
      encoding: "utf8",
    }).stdout;
    if (new RegExp(`OU\\s*=\\s*${teamId}\\b`).test(subject)) return hash;
  }
  return undefined;
}

const teamId = resolveForkBrand(process.env).appleTeamId;
const [appPath, explicitIdentity = process.env.LOCAL_SIGNING_IDENTITY] = process.argv.slice(2);
if (!appPath) {
  throw new Error(
    'Usage: node scripts/sign-macos-local.ts "<App.app>" [identity]; set LOCAL_SIGNING_IDENTITY, pass the identity, or install a signing certificate for the Apple team in forkBrand.json.',
  );
}
assertInstallArtifactProvenance({
  artifactPath: appPath,
  repo: process.cwd(),
  remote: process.env.T3CODE_SYNC_PROVENANCE_REMOTE,
});
const identity = explicitIdentity ?? (teamId ? findIdentityForTeam(teamId) : undefined);
if (!identity) {
  throw new Error(
    'Usage: node scripts/sign-macos-local.ts "<App.app>" [identity]; set LOCAL_SIGNING_IDENTITY, pass the identity, or install a signing certificate for the Apple team in forkBrand.json.',
  );
}

const entitlements = NodePath.join(
  NodePath.dirname(NodeURL.fileURLToPath(import.meta.url)),
  "sign-macos-local.entitlements.plist",
);

await sign({
  app: appPath,
  identity,
  // A self-signed identity is valid only under the code-signing policy, which
  // osx-sign's own identity lookup does not use; codesign itself accepts it.
  identityValidation: false,
  platform: "darwin",
  type: "distribution",
  preAutoEntitlements: false,
  optionsForFile: () => ({ hardenedRuntime: true, entitlements }),
});
console.log(`Signed ${appPath} with "${identity}".`);

// Read the result back: the team id is what the keychain and entitlements tie to.
const details = run("codesign", ["-dv", "--verbose=2", appPath]).stderr;
const signedTeam = /^TeamIdentifier=(.+)$/m.exec(details)?.[1];
console.log(`TeamIdentifier=${signedTeam ?? "none"}`);
if (explicitIdentity === undefined && teamId && signedTeam !== teamId) {
  throw new Error(`Expected the app to be signed by team ${teamId}, but it carries ${signedTeam}.`);
}
