import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as NetService from "@t3tools/shared/Net";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import { Command } from "effect/cli";

import { cli } from "../binCli.ts";
import { OrbitEnvironmentLinkError } from "../orbit/OrbitEnvironmentLink.ts";

const isLinkError = Schema.is(OrbitEnvironmentLinkError);

const layerCliRuntime = Layer.mergeAll(NodeServices.layer, NodeCrypto.layer, NetService.layer);
const runCli = (args: ReadonlyArray<string>) =>
  Command.runWith(cli, { version: "0.0.0" })(args).pipe(Effect.provide(layerCliRuntime));

it.effect("link-orbit takes the Orbit environment id and checks Linked environments first", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const baseDir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-link-orbit-cli-" });
    const refused = yield* runCli([
      "environment",
      "link-orbit",
      "env-clone",
      "--access",
      "full-access",
      "--base-dir",
      baseDir,
    ]).pipe(Effect.flip);
    // A fresh home has Linked environments off, so it fails before calling Orbit.
    assert.isTrue(isLinkError(refused));
    assert.strictEqual(isLinkError(refused) ? refused.code : null, "links_off");

    const invalid = yield* runCli([
      "environment",
      "link-orbit",
      "env-clone",
      "--access",
      "everything",
      "--base-dir",
      baseDir,
    ]).pipe(Effect.flip);
    assert.isFalse(isLinkError(invalid));
  }).pipe(Effect.provide(NodeServices.layer)),
);
