/** One process per open device, stopped with the last session. */
import * as NodeCrypto from "node:crypto";
import {
  DeviceOperationError,
  LOCAL_DEVICE_HOST_ID,
  type DeviceAnnotatorResult,
  type DeviceDetailInput,
  type DeviceError,
  type DeviceSession,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";

import { HostProcessEnvironment } from "@t3tools/shared/hostProcess";
import { resolveCommandPath } from "@t3tools/shared/shell";

import * as ServerConfig from "../config.ts";
import * as ProcessRunner from "../processRunner.ts";
import * as DeviceService from "./DeviceService.ts";

/** Operators point this at serve.mjs. Otherwise `annotator` is resolved from PATH. */
const ANNOTATOR_BIN_ENV = "T3_ANNOTATOR_BIN";
const ANNOTATOR_COMMAND = "annotator";

const decodeCliJson = Schema.decodeUnknownEffect(Schema.fromJsonString(Schema.Unknown));

const deviceKey = (hostId: string, deviceId: string) => `${hostId}\0${deviceId}`;

const directoryName = (hostId: string, deviceId: string) =>
  NodeCrypto.createHash("sha256").update(deviceKey(hostId, deviceId)).digest("hex");

interface AnnotatorLaunch {
  readonly command: string;
  readonly prefix: ReadonlyArray<string>;
}

interface RunningAnnotator {
  readonly directory: string;
  readonly stateFile: string;
  readonly url: string;
  readonly launch: AnnotatorLaunch;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** `start` prints JSON. Only its loopback annotations URL may reach the browser and the agent. */
const annotationsUrlFromBody = (body: unknown): string | null => {
  if (!isRecord(body) || body.running !== true || typeof body.url !== "string") return null;
  let url: URL;
  try {
    url = new URL(body.url);
  } catch {
    return null;
  }
  if (
    url.protocol !== "http:" ||
    url.hostname !== "127.0.0.1" ||
    url.username !== "" ||
    url.password !== "" ||
    url.pathname !== "/annotations"
  ) {
    return null;
  }
  return `${url.origin}/annotations`;
};

const cliError = (body: unknown, stderr: string): string => {
  if (isRecord(body) && typeof body.error === "string" && body.error.trim() !== "") {
    return body.error.trim();
  }
  const line = stderr.trim().split("\n").at(-1)?.trim();
  return line && line !== "" ? line : "The annotation server did not start.";
};

export class DeviceAnnotator extends Context.Service<
  DeviceAnnotator,
  {
    readonly ensure: (
      input: DeviceDetailInput,
    ) => Effect.Effect<DeviceAnnotatorResult, DeviceError>;
    /** Stops annotators whose device no longer has a session. An empty list stops them all. */
    readonly syncSessions: (sessions: ReadonlyArray<DeviceSession>) => Effect.Effect<void>;
  }
>()("t3/device/DeviceAnnotator") {}

export const make = Effect.fn("DeviceAnnotator.make")(function* (bin?: string) {
  const devices = yield* DeviceService.DeviceService;
  const runner = yield* ProcessRunner.ProcessRunner;
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const config = yield* ServerConfig.ServerConfig;
  const environment = yield* HostProcessEnvironment;
  const scope = yield* Scope.Scope;
  const lock = yield* Semaphore.make(1);
  const running = new Map<string, RunningAnnotator>();

  // A script path is run with node. A PATH command is already executable.
  const resolveLaunch = Effect.fn("DeviceAnnotator.resolveLaunch")(function* () {
    const configured = bin ?? environment[ANNOTATOR_BIN_ENV]?.trim() ?? "";
    if (configured !== "") {
      const exists = yield* fs.exists(configured).pipe(Effect.orElseSucceed(() => false));
      if (!exists) return { launch: null, missing: configured };
      return {
        launch: { command: "node", prefix: [configured] } satisfies AnnotatorLaunch,
        missing: null,
      };
    }
    const found = yield* resolveCommandPath(ANNOTATOR_COMMAND, { env: environment }).pipe(
      Effect.provideService(FileSystem.FileSystem, fs),
      Effect.provideService(Path.Path, path),
      Effect.catchTag("CommandResolutionError", () => Effect.succeed(null)),
    );
    if (found === null) return { launch: null, missing: null };
    const script = found.endsWith(".mjs") || found.endsWith(".cjs") || found.endsWith(".js");
    return {
      launch: script ? { command: "node", prefix: [found] } : { command: found, prefix: [] },
      missing: null,
    };
  });

  const runCli = (launch: AnnotatorLaunch, args: ReadonlyArray<string>) =>
    runner.run({
      command: launch.command,
      args: [...launch.prefix, ...args],
      timeout: "15 seconds",
    });

  const readBody = (stdout: string) =>
    decodeCliJson(stdout).pipe(
      Effect.map((body) => (isRecord(body) ? body : null)),
      Effect.orElseSucceed(() => null),
    );

  // `stop` exits 0 when the process was already gone. A non-zero exit keeps the files
  // so the next sync can retry; deleting a live store would strand the process.
  const stopEntry = (entry: RunningAnnotator) =>
    Effect.gen(function* () {
      const ran = yield* runCli(entry.launch, ["stop", "--state", entry.stateFile]).pipe(
        Effect.result,
      );
      if (Result.isFailure(ran) || ran.success.code === null || Number(ran.success.code) !== 0) {
        yield* Effect.logWarning("Device annotator did not stop", {
          stateFile: entry.stateFile,
          detail: Result.isFailure(ran) ? ran.failure.message : ran.success.stderr,
        });
        return false;
      }
      // A failed delete keeps the entry so the next sync can retry. A missing directory is done.
      yield* fs.remove(entry.directory, { recursive: true }).pipe(Effect.ignore);
      const stillThere = yield* fs.exists(entry.directory).pipe(Effect.orElseSucceed(() => true));
      if (stillThere) {
        yield* Effect.logWarning("Device annotator files were not removed", {
          directory: entry.directory,
        });
        return false;
      }
      return true;
    });

  const syncSessions = (sessions: ReadonlyArray<DeviceSession>) =>
    lock.withPermits(1)(
      Effect.gen(function* () {
        const live = new Set(
          sessions.map((session) => deviceKey(session.hostId, session.deviceId)),
        );
        const closed: Array<readonly [string, RunningAnnotator]> = [];
        for (const entry of running) {
          if (!live.has(entry[0])) closed.push(entry);
        }
        for (const [key, entry] of closed) {
          if (yield* stopEntry(entry)) running.delete(key);
        }
      }),
    );

  const ensure = (input: DeviceDetailInput) =>
    lock.withPermits(1)(
      Effect.gen(function* () {
        const hostId = input.hostId ?? LOCAL_DEVICE_HOST_ID;
        const deviceId = input.deviceId;
        const key = deviceKey(hostId, deviceId);
        const isLive = (yield* devices.state).sessions.some(
          (session) => session.hostId === hostId && session.deviceId === deviceId,
        );
        if (!isLive) {
          return {
            annotationsUrl: null,
            error: "Open the device before annotating.",
          } satisfies DeviceAnnotatorResult;
        }
        // `start` is idempotent: a later open adopts the process if this one died.
        const resolved = yield* resolveLaunch();
        if (!resolved.launch) {
          return {
            annotationsUrl: null,
            error:
              resolved.missing === null
                ? "The annotator is not installed."
                : `The annotator is not installed at ${resolved.missing}.`,
          } satisfies DeviceAnnotatorResult;
        }
        const launch = resolved.launch;
        const directory = path.join(
          config.stateDir,
          "device-annotators",
          directoryName(hostId, deviceId),
        );
        const stateFile = path.join(directory, "state.json");
        const store = path.join(directory, "store");
        const made = yield* fs.makeDirectory(directory, { recursive: true }).pipe(Effect.result);
        if (Result.isFailure(made)) {
          return yield* new DeviceOperationError({
            operation: "annotator",
            reason: "settings_failed",
            cause: made.failure,
          });
        }
        const ran = yield* runCli(launch, ["start", "--state", stateFile, "--store", store]).pipe(
          Effect.result,
        );
        const entry = { directory, stateFile, url: "", launch };
        if (Result.isFailure(ran)) {
          yield* stopEntry(entry);
          return {
            annotationsUrl: null,
            error: ran.failure.message,
          } satisfies DeviceAnnotatorResult;
        }
        const body = yield* readBody(ran.success.stdout);
        const url =
          ran.success.code !== null && Number(ran.success.code) === 0
            ? annotationsUrlFromBody(body)
            : null;
        if (!url) {
          yield* stopEntry(entry);
          return {
            annotationsUrl: null,
            error: cliError(body, ran.success.stderr),
          } satisfies DeviceAnnotatorResult;
        }
        const stillLive = (yield* devices.state).sessions.some(
          (session) => session.hostId === hostId && session.deviceId === deviceId,
        );
        if (!stillLive) {
          yield* stopEntry({ directory, stateFile, url, launch });
          return {
            annotationsUrl: null,
            error: "Open the device before annotating.",
          } satisfies DeviceAnnotatorResult;
        }
        running.set(key, { directory, stateFile, url, launch });
        return { annotationsUrl: url, error: null } satisfies DeviceAnnotatorResult;
      }),
    );

  // Registered before the watcher so shutdown interrupts the watcher first, then stops
  // whatever it had not reached. The watcher holds the same lock.
  yield* Effect.addFinalizer(() => syncSessions([]));
  yield* DeviceService.stateStream(devices).pipe(
    Stream.runForEach((state) => syncSessions(state.sessions)),
    Effect.forkIn(scope),
  );

  return DeviceAnnotator.of({ ensure, syncSessions });
});

export const layer = Layer.effect(DeviceAnnotator, make());
