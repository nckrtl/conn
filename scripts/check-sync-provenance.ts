#!/usr/bin/env node
// @effect-diagnostics nodeBuiltinImport:off globalConsole:off
import {
  checkArtifactSyncProvenance,
  checkPublishedSyncSource,
  parseSyncSourceCliArgs,
  readProvenanceManifest,
  syncSourceProvenanceMessage,
} from "./sync-source-provenance.ts";

try {
  const args = parseSyncSourceCliArgs(process.argv.slice(2));
  const provenance =
    args.artifact === undefined
      ? checkPublishedSyncSource({ repo: args.repo, remote: args.remote })
      : checkArtifactSyncProvenance({
          repo: args.repo,
          remote: args.remote,
          artifactPath: args.artifact,
          manifest: readProvenanceManifest(args.artifact),
        });
  if (args.json) {
    console.log(JSON.stringify(provenance, null, 2));
  } else {
    console.log(`${provenance.commit}\n${provenance.syncRef}\n${provenance.remoteUrl}`);
  }
} catch (error) {
  console.error(syncSourceProvenanceMessage(error));
  process.exitCode = 1;
}
