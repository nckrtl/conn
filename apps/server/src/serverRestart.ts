import { ServerRestartError, type ServerRestartResult } from "@t3tools/contracts";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Context from "effect/Context";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";

import { resolveServiceLauncherMode } from "./cloud/serviceLauncherClient.ts";
import * as ServerConfig from "./config.ts";
import * as ProcessRunner from "./processRunner.ts";

// Lets the RPC acknowledgement reach the client before shutdown closes sockets.
const STOP_DELAY = Duration.millis(250);
const LAUNCHCTL_TIMEOUT = Duration.seconds(5);

/**
 * Restarts a supervised server by stopping it the way its supervisor would:
 * SIGTERM runs the normal graceful shutdown, and the supervisor starts the
 * current install again. `available` is false wherever nothing would bring
 * the server back, so clients never offer a one-way stop.
 */
export class ServerRestart extends Context.Service<
  ServerRestart,
  {
    readonly available: boolean;
    readonly restart: Effect.Effect<ServerRestartResult, ServerRestartError>;
  }
>()("t3/serverRestart") {}

/**
 * launchd sets XPC_SERVICE_NAME to the job label. Terminal shells get "0" and
 * apps opened from Finder get "application.<bundle id>…", neither of which is
 * a job launchd restarts.
 */
export function launchdJobLabel(xpcServiceName: string | undefined): string | null {
  const label = xpcServiceName?.trim();
  if (!label || label === "0" || label.startsWith("application.")) return null;
  return label;
}

/** Reads the `properties = …` line of `launchctl print` for the keepalive flag. */
export function launchctlPrintKeepsAlive(output: string): boolean {
  return output.split("\n").some(
    (line) =>
      /^\s*properties = /.test(line) &&
      line
        .split("=")[1]!
        .split("|")
        .some((flag) => flag.trim() === "keepalive"),
  );
}

export const make = Effect.fn("serverRestart.make")(function* (options?: {
  readonly stop?: Effect.Effect<void>;
}) {
  const serverConfig = yield* ServerConfig.ServerConfig;
  const runner = yield* ProcessRunner.ProcessRunner;
  const platform = yield* HostProcess.Platform;
  const environment = yield* HostProcess.Environment;
  const uid = yield* HostProcess.UserId;
  const launcher = yield* resolveServiceLauncherMode().pipe(
    Effect.orElseSucceed(() => ({ managed: false })),
  );
  const stop = options?.stop ?? Effect.sync(() => process.kill(process.pid, "SIGTERM"));

  // The desktop app owns its backend's lifecycle and the service launcher
  // owns its child's; both have their own update paths. Only a server that a
  // launchd KeepAlive job runs directly is restarted by exiting.
  const label = launchdJobLabel(environment.XPC_SERVICE_NAME);
  const available =
    serverConfig.mode !== "desktop" &&
    !launcher.managed &&
    platform === "darwin" &&
    label !== null &&
    uid !== undefined &&
    (yield* runner
      .run({
        command: "launchctl",
        args: ["print", `gui/${uid}/${label}`],
        timeout: LAUNCHCTL_TIMEOUT,
      })
      .pipe(
        Effect.map((result) => result.code === 0 && launchctlPrintKeepsAlive(result.stdout)),
        Effect.orElseSucceed(() => false),
      ));

  const stopping = yield* Ref.make(false);

  const restart = Effect.gen(function* () {
    if (!available) {
      return yield* new ServerRestartError({
        reason: "This server has no supervisor that would start it again.",
      });
    }
    if (yield* Ref.getAndSet(stopping, true)) {
      return yield* new ServerRestartError({ reason: "The server is already restarting." });
    }
    yield* Effect.logInfo("Server restart requested; stopping for the supervisor to restart.", {
      label,
    });
    yield* Effect.sleep(STOP_DELAY).pipe(Effect.andThen(stop), Effect.forkDetach);
    return { accepted: true as const };
  });

  return ServerRestart.of({ available, restart });
});

export const layer = Layer.effect(ServerRestart, make()).pipe(Layer.provide(ProcessRunner.layer));

export const layerTest = (available: boolean) =>
  Layer.succeed(
    ServerRestart,
    ServerRestart.of({
      available,
      restart: available
        ? Effect.succeed({ accepted: true as const })
        : Effect.fail(new ServerRestartError({ reason: "Not supervised in tests." })),
    }),
  );
