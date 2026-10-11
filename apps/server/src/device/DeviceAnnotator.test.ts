import { describe, expect, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { HostProcessEnvironment } from "@t3tools/shared/hostProcess";
import {
  DeviceId,
  LOCAL_DEVICE_HOST_ID,
  ThreadId,
  type DeviceServiceState,
  type DeviceSession,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as PubSub from "effect/PubSub";
import * as ChildProcessSpawner from "effect/unstable/process/ChildProcessSpawner";

import * as ServerConfig from "../config.ts";
import * as ProcessRunner from "../processRunner.ts";
import * as DeviceAnnotator from "./DeviceAnnotator.ts";
import * as DeviceService from "./DeviceService.ts";

const baseState: DeviceServiceState = {
  hosts: [],
  hostStatus: "idle",
  hostStatuses: {},
  devices: [],
  sessions: [],
  onboardingCompleted: false,
  agentAccessEnabled: false,
  hubBasePath: "/api/device-hub",
  revision: 0,
};

const session = (deviceId: string): DeviceSession => ({
  threadId: ThreadId.make("thread-1"),
  hostId: LOCAL_DEVICE_HOST_ID,
  deviceId: DeviceId.make(deviceId),
  platform: "ios",
  openedAt: "2026-01-01T00:00:00.000Z",
});

const output = (code: number, stdout: string, stderr = ""): ProcessRunner.ProcessRunOutput => ({
  code: ChildProcessSpawner.ExitCode(code),
  stdout,
  stderr,
  timedOut: false,
  stdoutTruncated: false,
  stderrTruncated: false,
  stdoutInvalidUtf8: false,
  stderrInvalidUtf8: false,
});

const flag = (input: ProcessRunner.ProcessRunInput, name: string) =>
  input.args[input.args.indexOf(name) + 1];

const startAnnotator = (input: {
  readonly sessions: ReadonlyArray<DeviceSession>;
  readonly binName: string;
  readonly writeBin: boolean;
  readonly run: ProcessRunner.ProcessRunner["Service"]["run"];
}) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const stateDir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-device-annotator-" });
    const bin = path.join(stateDir, input.binName);
    if (input.writeBin) yield* fs.writeFileString(bin, "");
    const pubsub = yield* PubSub.unbounded<DeviceServiceState>();
    const devices = {
      state: Effect.succeed({ ...baseState, sessions: input.sessions }),
      subscribe: PubSub.subscribe(pubsub),
    } as DeviceService.DeviceService["Service"];
    const annotator = yield* DeviceAnnotator.make(bin).pipe(
      Effect.provideService(DeviceService.DeviceService, devices),
      Effect.provideService(ProcessRunner.ProcessRunner, { run: input.run }),
      Effect.provideService(ServerConfig.ServerConfig, {
        stateDir,
      } as ServerConfig.ServerConfig["Service"]),
    );
    return { annotator, fs, path, stateDir, bin };
  });

describe("DeviceAnnotator", () => {
  it.effect("reports a missing binary and does not spawn", () =>
    Effect.gen(function* () {
      const calls: string[] = [];
      const { annotator, fs, path, stateDir } = yield* startAnnotator({
        sessions: [session("UDID")],
        binName: "missing-serve.mjs",
        writeBin: false,
        run: () => {
          calls.push("run");
          return Effect.die("The test must not spawn the annotator");
        },
      });
      const result = yield* annotator.ensure({
        hostId: LOCAL_DEVICE_HOST_ID,
        deviceId: DeviceId.make("UDID"),
      });
      expect(result.annotationsUrl).toBeNull();
      expect(result.error).toContain("missing-serve.mjs");
      expect(calls).toEqual([]);
      expect(yield* fs.exists(path.join(stateDir, "device-annotators"))).toBe(false);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect("does not spawn unless that device has a session", () =>
    Effect.gen(function* () {
      const calls: string[] = [];
      const { annotator, fs, path, stateDir } = yield* startAnnotator({
        sessions: [],
        binName: "serve.mjs",
        writeBin: true,
        run: () => {
          calls.push("run");
          return Effect.die("The test must not spawn the annotator");
        },
      });
      expect(yield* annotator.ensure({ deviceId: DeviceId.make("UDID") })).toEqual({
        annotationsUrl: null,
        error: "Open the device before annotating.",
      });
      expect(calls).toEqual([]);
      expect(yield* fs.exists(path.join(stateDir, "device-annotators"))).toBe(false);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect("keeps one loopback annotator per open device and stops the rest", () =>
    Effect.gen(function* () {
      const calls: ProcessRunner.ProcessRunInput[] = [];
      const phone = session("phone");
      const tablet = session("tablet");
      const { annotator, fs, path, stateDir, bin } = yield* startAnnotator({
        sessions: [phone, tablet],
        binName: "serve.mjs",
        writeBin: true,
        run: (input) => {
          calls.push(input);
          const name = input.args[1];
          if (name === "stop") return Effect.succeed(output(0, '{"running":false}'));
          return Effect.succeed(
            output(0, '{"running":true,"url":"http://127.0.0.1:4321/annotations"}'),
          );
        },
      });
      expect(yield* annotator.ensure({ hostId: phone.hostId, deviceId: phone.deviceId })).toEqual({
        annotationsUrl: "http://127.0.0.1:4321/annotations",
        error: null,
      });
      expect(yield* annotator.ensure({ hostId: tablet.hostId, deviceId: tablet.deviceId })).toEqual(
        {
          annotationsUrl: "http://127.0.0.1:4321/annotations",
          error: null,
        },
      );
      const started = calls.filter((call) => call.args[1] === "start");
      expect(started.map((call) => call.command)).toEqual(["node", "node"]);
      expect(started.every((call) => call.args[0] === bin)).toBe(true);
      const directories = started.map((call) => path.dirname(flag(call, "--state")!));
      expect(new Set(directories).size).toBe(2);
      const root = path.join(stateDir, "device-annotators");
      expect(directories.every((directory) => directory.startsWith(`${root}${path.sep}`))).toBe(
        true,
      );
      expect(started.every((call) => path.basename(flag(call, "--store")!) === "store")).toBe(true);
      expect(started.every((call) => path.basename(flag(call, "--state")!) === "state.json")).toBe(
        true,
      );
      for (const directory of directories) expect(yield* fs.exists(directory)).toBe(true);

      yield* annotator.syncSessions([phone]);
      const stopped = calls.filter((call) => call.args[1] === "stop");
      expect(stopped).toHaveLength(1);
      expect(flag(stopped[0]!, "--state")).toBe(flag(started[1]!, "--state"));
      expect(yield* fs.exists(directories[1]!)).toBe(false);
      expect(yield* fs.exists(directories[0]!)).toBe(true);

      yield* annotator.syncSessions([]);
      expect(calls.filter((call) => call.args[1] === "stop")).toHaveLength(2);
      expect(yield* fs.exists(directories[0]!)).toBe(false);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect("rejects a non-loopback URL and stops that process", () =>
    Effect.gen(function* () {
      const scripts = [
        output(0, '{"running":true,"url":"http://10.0.0.8:9/annotations"}'),
        output(0, '{"running":true,"url":"http://user:pw@127.0.0.1:9/annotations"}'),
        output(1, '{"running":false,"error":"The port is taken."}'),
      ];
      const calls: ProcessRunner.ProcessRunInput[] = [];
      const phone = session("phone");
      const { annotator, fs, path } = yield* startAnnotator({
        sessions: [phone],
        binName: "serve.mjs",
        writeBin: true,
        run: (input) => {
          calls.push(input);
          if (input.args[1] === "stop") return Effect.succeed(output(0, '{"running":false}'));
          return Effect.succeed(scripts.shift()!);
        },
      });
      expect(yield* annotator.ensure({ deviceId: phone.deviceId })).toEqual({
        annotationsUrl: null,
        error: "The annotation server did not start.",
      });
      expect(yield* annotator.ensure({ deviceId: phone.deviceId })).toEqual({
        annotationsUrl: null,
        error: "The annotation server did not start.",
      });
      expect(yield* annotator.ensure({ deviceId: phone.deviceId })).toEqual({
        annotationsUrl: null,
        error: "The port is taken.",
      });
      const started = calls.filter((call) => call.args[1] === "start");
      const stopped = calls.filter((call) => call.args[1] === "stop");
      expect(started).toHaveLength(3);
      expect(stopped).toHaveLength(3);
      expect(stopped.map((call) => flag(call, "--state"))).toEqual(
        started.map((call) => flag(call, "--state")),
      );
      for (const call of started) {
        expect(yield* fs.exists(path.dirname(flag(call, "--state")!))).toBe(false);
      }
      yield* annotator.syncSessions([]);
      expect(calls.filter((call) => call.args[1] === "stop")).toHaveLength(3);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  const resolvedAnnotator = (input: {
    readonly env: NodeJS.ProcessEnv;
    readonly run: ProcessRunner.ProcessRunner["Service"]["run"];
    readonly binName?: string;
  }) =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const stateDir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-device-annotator-" });
      const sessions: ReadonlyArray<DeviceSession> = [session("UDID")];
      let env = input.env;
      if (input.binName !== undefined) {
        const bin = path.join(stateDir, input.binName);
        yield* fs.writeFileString(bin, "");
        env = { ...env, T3_ANNOTATOR_BIN: bin };
      }
      const pubsub = yield* PubSub.unbounded<DeviceServiceState>();
      const devices = {
        state: Effect.succeed({ ...baseState, sessions }),
        subscribe: PubSub.subscribe(pubsub),
      } as DeviceService.DeviceService["Service"];
      const annotator = yield* DeviceAnnotator.make().pipe(
        Effect.provideService(DeviceService.DeviceService, devices),
        Effect.provideService(ProcessRunner.ProcessRunner, { run: input.run }),
        Effect.provideService(ServerConfig.ServerConfig, {
          stateDir,
        } as ServerConfig.ServerConfig["Service"]),
        Effect.provideService(HostProcessEnvironment, env),
      );
      return { annotator, fs, path, stateDir };
    });

  it.effect("reports a missing install without a path when nothing is configured", () =>
    Effect.gen(function* () {
      const calls: string[] = [];
      const { annotator } = yield* resolvedAnnotator({
        env: { PATH: "" },
        run: () => {
          calls.push("run");
          return Effect.die("The test must not spawn the annotator");
        },
      });
      expect(
        yield* annotator.ensure({
          hostId: LOCAL_DEVICE_HOST_ID,
          deviceId: DeviceId.make("UDID"),
        }),
      ).toEqual({ annotationsUrl: null, error: "The annotator is not installed." });
      expect(calls).toEqual([]);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect("runs the script named by T3_ANNOTATOR_BIN", () =>
    Effect.gen(function* () {
      const calls: ProcessRunner.ProcessRunInput[] = [];
      const { annotator, path, stateDir } = yield* resolvedAnnotator({
        env: { PATH: "" },
        binName: "serve.mjs",
        run: (input) => {
          calls.push(input);
          if (input.args.includes("stop")) return Effect.succeed(output(0, '{"running":false}'));
          return Effect.succeed(
            output(0, '{"running":true,"url":"http://127.0.0.1:9/annotations"}'),
          );
        },
      });
      expect(
        yield* annotator.ensure({
          hostId: LOCAL_DEVICE_HOST_ID,
          deviceId: DeviceId.make("UDID"),
        }),
      ).toEqual({ annotationsUrl: "http://127.0.0.1:9/annotations", error: null });
      expect(calls.map((call) => call.command)).toEqual(["node"]);
      expect(calls[0]?.args[0]).toBe(path.join(stateDir, "serve.mjs"));
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );
});
