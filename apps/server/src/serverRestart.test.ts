import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import {
  HostProcessEnvironment,
  HostProcessPlatform,
  HostProcessUserId,
} from "@t3tools/shared/hostProcess";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as TestClock from "effect/testing/TestClock";
import * as ChildProcessSpawner from "effect/unstable/process/ChildProcessSpawner";

import * as ServerConfig from "./config.ts";
import * as ProcessRunner from "./processRunner.ts";
import {
  launchctlPrintKeepsAlive,
  launchdJobLabel,
  make as makeServerRestart,
} from "./serverRestart.ts";

const LAUNCHCTL_KEEPALIVE = [
  "gui/501/com.example.t3 = {",
  "\tstate = running",
  "\tproperties = keepalive | runatload | inferred program",
  "}",
].join("\n");

interface Host {
  readonly mode?: ServerConfig.RuntimeMode;
  readonly platform?: NodeJS.Platform;
  readonly xpcServiceName?: string;
  readonly launchctlOutput?: string;
}

const configLayer = (mode: ServerConfig.RuntimeMode) =>
  Layer.effect(
    ServerConfig.ServerConfig,
    Effect.gen(function* () {
      return { ...(yield* ServerConfig.ServerConfig), mode };
    }),
  ).pipe(Layer.provide(ServerConfig.layerTest(process.cwd(), { prefix: "t3-server-restart-" })));

const makeWith = (host: Host, stop: Effect.Effect<void> = Effect.void) => {
  const commands: Array<string> = [];
  const runner = ProcessRunner.ProcessRunner.of({
    run: (input) =>
      Effect.sync(() => {
        commands.push(`${input.command} ${input.args.join(" ")}`);
        return {
          stdout: host.launchctlOutput ?? LAUNCHCTL_KEEPALIVE,
          stderr: "",
          code: ChildProcessSpawner.ExitCode(0),
          timedOut: false,
          stdoutTruncated: false,
          stderrTruncated: false,
          stdoutInvalidUtf8: false,
          stderrInvalidUtf8: false,
        };
      }),
  });
  return makeServerRestart({ stop }).pipe(
    Effect.provide(configLayer(host.mode ?? "web")),
    Effect.provideService(ProcessRunner.ProcessRunner, runner),
    Effect.provideService(HostProcessPlatform, host.platform ?? "darwin"),
    Effect.provideService(HostProcessUserId, 501),
    Effect.provideService(
      HostProcessEnvironment,
      host.xpcServiceName === undefined ? {} : { XPC_SERVICE_NAME: host.xpcServiceName },
    ),
    Effect.map((service) => ({ service, commands })),
  );
};

it("reads the launchd job label only from launchd-started processes", () => {
  expect(launchdJobLabel("com.example.t3")).toBe("com.example.t3");
  expect(launchdJobLabel("0")).toBeNull();
  expect(launchdJobLabel("application.com.mitchellh.ghostty.123.456")).toBeNull();
  expect(launchdJobLabel(undefined)).toBeNull();
});

it("finds keepalive among launchctl print properties", () => {
  expect(launchctlPrintKeepsAlive(LAUNCHCTL_KEEPALIVE)).toBe(true);
  expect(launchctlPrintKeepsAlive("\tproperties = runatload | inferred program\n")).toBe(false);
  expect(launchctlPrintKeepsAlive("\tkeepalive = 1\n")).toBe(false);
});

it.layer(NodeServices.layer)("ServerRestart", (it) => {
  it.effect("is available for a launchd KeepAlive job", () =>
    Effect.gen(function* () {
      const { service, commands } = yield* makeWith({ xpcServiceName: "com.example.t3" });
      expect(service.available).toBe(true);
      expect(commands).toEqual(["launchctl print gui/501/com.example.t3"]);
    }),
  );

  it.effect("is unavailable wherever nothing would start the server again", () =>
    Effect.gen(function* () {
      const cases: ReadonlyArray<readonly [string, Host]> = [
        ["desktop backend", { xpcServiceName: "com.example.t3", mode: "desktop" }],
        [
          "launchd job without KeepAlive",
          { xpcServiceName: "com.example.t3", launchctlOutput: "\tproperties = runatload\n" },
        ],
        ["not macOS", { xpcServiceName: "com.example.t3", platform: "linux" }],
        ["terminal", { xpcServiceName: "0" }],
        ["no launchd", {}],
      ];
      for (const [name, host] of cases) {
        const { service } = yield* makeWith(host);
        expect(service.available, name).toBe(false);
      }
    }),
  );

  it.effect("refuses to restart a server nothing would bring back", () =>
    Effect.gen(function* () {
      const stopped = yield* Deferred.make<void>();
      const { service } = yield* makeWith(
        { xpcServiceName: "0" },
        Deferred.succeed(stopped, undefined),
      );
      const error = yield* Effect.flip(service.restart);
      expect(error._tag).toBe("ServerRestartError");
      expect(yield* Deferred.isDone(stopped)).toBe(false);
    }),
  );

  it.effect("acknowledges first, then stops once", () =>
    Effect.gen(function* () {
      const stopped = yield* Deferred.make<void>();
      const { service } = yield* makeWith(
        { xpcServiceName: "com.example.t3" },
        Deferred.succeed(stopped, undefined),
      );
      expect(yield* service.restart).toEqual({ accepted: true });
      expect(yield* Deferred.isDone(stopped)).toBe(false);

      const waiter = yield* Deferred.await(stopped).pipe(Effect.forkChild);
      yield* TestClock.adjust("1 second");
      yield* Fiber.join(waiter);

      const again = yield* Effect.flip(service.restart);
      expect(again.reason).toBe("The server is already restarting.");
    }),
  );
});
