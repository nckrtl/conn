import * as NodeNet from "node:net";

import {
  AnnotatorProjectNotFoundError,
  AnnotatorServerError,
  type AnnotatorServerAction,
  type AnnotatorServerStatus,
  type ProjectId,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Semaphore from "effect/Semaphore";

import { ServerConfig } from "../config.ts";
import * as ProcessRunner from "../processRunner.ts";
import * as ProjectService from "../project/ProjectService.ts";

// rooms-patches: runs a project's @nckrtl/annotator server through the annotator's own
// start/stop/status CLI, which detaches the server and tracks it in a state file.

/** Pinned so every environment runs the same server; npx caches it after the first run. */
export const ANNOTATOR_PACKAGE = "@nckrtl/annotator@0.3.0";

export interface AnnotatorHost {
  /** IP for `--host`, or null to listen on every address. */
  readonly bind: string | null;
  /** Host for the returned URL when `bind` is null: the name the client used. */
  readonly publicHost: string | null;
}

/**
 * Binds the address the client reached this server on, so the client can reach the
 * annotator too. A loopback or unknown address stays on 127.0.0.1. A host name listens
 * everywhere and keeps the name in the URL, because `--host` takes only an IP.
 */
export function annotatorHost(clientHost: string | undefined): AnnotatorHost {
  const host = (clientHost ?? "").replace(/^\[(.*)\]$/, "$1").toLowerCase();
  if (host === "" || host === "localhost" || host === "0.0.0.0" || host === "::")
    return { bind: "127.0.0.1", publicHost: null };
  if (NodeNet.isIP(host) !== 0) {
    const loopback = host === "::1" || host.startsWith("127.");
    return { bind: loopback ? "127.0.0.1" : host, publicHost: null };
  }
  return { bind: null, publicHost: host };
}

/** Arguments after `npx`. `--host` without a value must come last. */
function annotatorArgs(input: {
  readonly action: AnnotatorServerAction;
  readonly statePath: string;
  readonly storePath: string;
  readonly host: AnnotatorHost;
}): string[] {
  const base = ["-y", ANNOTATOR_PACKAGE, input.action, "--state", input.statePath];
  if (input.action !== "start") return base;
  return [
    ...base,
    "--store",
    input.storePath,
    ...(input.host.bind === null ? ["--host"] : ["--host", input.host.bind]),
  ];
}

/**
 * Reads the JSON line the CLI prints. A server listening on every address prints its
 * first network address, so the URL takes the client's host name instead.
 */
function parseAnnotatorOutput(stdout: string, host: AnnotatorHost): AnnotatorServerStatus | null {
  const line = stdout.trim().split("\n").at(-1) ?? "";
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null) return null;
  const { running, url, error } = parsed as Record<string, unknown>;
  if (typeof running !== "boolean" || error !== undefined) return null;
  if (!running || typeof url !== "string") return { running: false, url: null };
  if (host.publicHost === null) return { running, url };
  try {
    const target = new URL(url);
    target.hostname = host.publicHost;
    return { running, url: target.href };
  } catch {
    return null;
  }
}

export class AnnotatorServer extends Context.Service<
  AnnotatorServer,
  {
    readonly run: (input: {
      readonly projectId: ProjectId;
      readonly action: AnnotatorServerAction;
      /** The host the client used to reach this server. */
      readonly clientHost: string | undefined;
    }) => Effect.Effect<
      AnnotatorServerStatus,
      AnnotatorServerError | AnnotatorProjectNotFoundError
    >;
  }
>()("t3/preview/AnnotatorServer") {}

const make = Effect.gen(function* () {
  const config = yield* ServerConfig;
  const path = yield* Path.Path;
  const processes = yield* ProcessRunner.ProcessRunner;
  const projects = yield* ProjectService.ProjectService;
  // One CLI call at a time, so two Start clicks cannot spawn two servers.
  const lock = yield* Semaphore.make(1);

  const run: AnnotatorServer["Service"]["run"] = Effect.fn("AnnotatorServer.run")(
    function* ({ projectId, action, clientHost }) {
      const project = yield* projects.getById(projectId).pipe(
        Effect.catchTags({
          ProjectOperationError: () => Effect.succeedNone,
        }),
      );
      if (Option.isNone(project)) return yield* new AnnotatorProjectNotFoundError({ projectId });
      // T3 state, not the project's checkout, so the store never shows up in Git.
      const directory = path.join(
        config.stateDir,
        "annotator",
        projectId.replace(/[^A-Za-z0-9._-]/g, "_"),
      );
      const statePath = path.join(directory, "server.json");
      const host = annotatorHost(clientHost);
      const fail = (cause?: unknown) =>
        new AnnotatorServerError({
          action,
          projectId,
          logPath: path.join(directory, "server.log"),
          ...(cause === undefined ? {} : { cause }),
        });
      const output = yield* processes
        .run({
          command: "npx",
          args: annotatorArgs({
            action,
            statePath,
            storePath: path.join(directory, "annotations"),
            host,
          }),
          // The agent skill the server serves names its working directory as the project.
          cwd: project.value.workspaceRoot,
          // The first run downloads the package.
          timeout: action === "start" ? "2 minutes" : "30 seconds",
        })
        .pipe(Effect.mapError(fail));
      const status = parseAnnotatorOutput(output.stdout, host);
      if (status === null) return yield* fail();
      return status;
    },
    (effect) => lock.withPermits(1)(effect),
  );

  return AnnotatorServer.of({ run });
});

export const layer = Layer.effect(AnnotatorServer, make);
