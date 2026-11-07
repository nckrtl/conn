#!/usr/bin/env node
// @effect-diagnostics nodeBuiltinImport:off globalConsole:off
import {
  parseSyncSourceCliArgs,
  publishExactHeadToSyncBranch,
  syncSourceProvenanceMessage,
} from "./sync-source-provenance.ts";

try {
  const args = parseSyncSourceCliArgs(process.argv.slice(2));
  if (args.artifact !== undefined) {
    throw new Error(
      "publish-sync-branch does not take --artifact; publish HEAD, then verify the artifact",
    );
  }
  const provenance = publishExactHeadToSyncBranch({ repo: args.repo, remote: args.remote });
  if (args.json) {
    console.log(JSON.stringify(provenance, null, 2));
  } else {
    console.log(`${provenance.commit}\n${provenance.syncRef}\n${provenance.remoteUrl}`);
  }
} catch (error) {
  console.error(syncSourceProvenanceMessage(error));
  process.exitCode = 1;
}
