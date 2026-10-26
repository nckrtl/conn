import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import { ProjectId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";

import * as ServerConfig from "../config.ts";
import * as ProcessRunner from "../processRunner.ts";
import * as ProjectService from "../project/ProjectService.ts";
import * as AnnotatorServer from "./AnnotatorServer.ts";

const projectId = ProjectId.make("project-1");
const output = (stdout: string, code = 0) => ({
  stdout,
  stderr: "",
  code: code as ProcessRunner.ProcessRunOutput["code"],
  timedOut: false,
  stdoutTruncated: false,
  stderrTruncated: false,
  stdoutInvalidUtf8: false,
  stderrInvalidUtf8: false,
});

const runService = (input: {
  readonly stdout: string;
  readonly action: "start" | "stop" | "status";
  readonly clientHost: string | undefined;
  readonly known?: boolean;
}) => {
  const calls: ProcessRunner.ProcessRunInput[] = [];
  const layer = AnnotatorServer.layer.pipe(
    Layer.provide(
      Layer.mergeAll(
        Layer.succeed(ProcessRunner.ProcessRunner, {
          run: (call) => {
            calls.push(call);
            return Effect.succeed(output(input.stdout));
          },
        }),
        Layer.mock(ProjectService.ProjectService)({
          getById: () =>
            Effect.succeed(
              input.known === false
                ? Option.none()
                : Option.some({ workspaceRoot: "/work/shop" } as never),
            ),
        }),
        ServerConfig.layerTest(process.cwd(), { prefix: "t3-annotator-server-" }),
      ),
    ),
    Layer.provideMerge(NodeServices.layer),
  );
  return AnnotatorServer.AnnotatorServer.pipe(
    Effect.flatMap((server) =>
      server.run({ projectId, action: input.action, clientHost: input.clientHost }),
    ),
    Effect.provide(layer),
    Effect.map((status) => ({ status, calls })),
  );
};

it("binds the address the client used and keeps the store out of the project", () => {
  assert.deepStrictEqual(AnnotatorServer.annotatorHost("10.44.0.7"), {
    bind: "10.44.0.7",
    publicHost: null,
  });
  assert.deepStrictEqual(AnnotatorServer.annotatorHost("127.0.0.1"), {
    bind: "127.0.0.1",
    publicHost: null,
  });
  assert.deepStrictEqual(AnnotatorServer.annotatorHost("[::1]"), {
    bind: "127.0.0.1",
    publicHost: null,
  });
  assert.deepStrictEqual(AnnotatorServer.annotatorHost(undefined), {
    bind: "127.0.0.1",
    publicHost: null,
  });
  assert.deepStrictEqual(AnnotatorServer.annotatorHost("Beast.tail.ts.net"), {
    bind: null,
    publicHost: "beast.tail.ts.net",
  });
});

it.effect("starts the pinned annotator in the project folder with a state file in T3 state", () =>
  Effect.gen(function* () {
    const { status, calls } = yield* runService({
      action: "start",
      clientHost: "10.44.0.7",
      stdout: '{"running":true,"pid":42,"port":47821,"url":"http://10.44.0.7:47821/annotations"}\n',
    });
    assert.deepStrictEqual(status, { running: true, url: "http://10.44.0.7:47821/annotations" });
    const [call] = calls;
    assert.strictEqual(call?.command, "npx");
    assert.strictEqual(call?.cwd, "/work/shop");
    const args = call?.args ?? [];
    assert.deepStrictEqual(args.slice(0, 4), [
      "-y",
      AnnotatorServer.ANNOTATOR_PACKAGE,
      "start",
      "--state",
    ]);
    assert.match(args[4] ?? "", /annotator[/\\]project-1[/\\]server\.json$/);
    assert.strictEqual(args[5], "--store");
    assert.match(args[6] ?? "", /annotator[/\\]project-1[/\\]annotations$/);
    assert.deepStrictEqual(args.slice(7), ["--host", "10.44.0.7"]);
    assert.notInclude(args, "--allow-origin");
  }),
);

it.effect("listens everywhere for a host name and returns the URL under that name", () =>
  Effect.gen(function* () {
    const { status, calls } = yield* runService({
      action: "start",
      clientHost: "beast",
      stdout: '{"running":true,"pid":42,"url":"http://192.168.1.5:47821/annotations"}',
    });
    assert.deepStrictEqual(status, { running: true, url: "http://beast:47821/annotations" });
    assert.strictEqual(calls[0]?.args.at(-1), "--host");
  }),
);

it.effect("stops and reads status with the same state file only", () =>
  Effect.gen(function* () {
    const stopped = yield* runService({
      action: "stop",
      clientHost: "10.44.0.7",
      stdout: '{"running":false,"stopped":true}',
    });
    assert.deepStrictEqual(stopped.status, { running: false, url: null });
    assert.deepStrictEqual(stopped.calls[0]?.args.slice(2, 4), ["stop", "--state"]);
    assert.lengthOf(stopped.calls[0]?.args ?? [], 5);
    const status = yield* runService({
      action: "status",
      clientHost: "10.44.0.7",
      stdout: '{"running":false}',
    });
    assert.deepStrictEqual(status.status, { running: false, url: null });
  }),
);

it.effect("fails with the log path when the CLI reports an error", () =>
  Effect.gen(function* () {
    const error = yield* runService({
      action: "start",
      clientHost: "10.44.0.7",
      stdout: '{"running":false,"error":"The annotation server did not start."}',
    }).pipe(Effect.flip);
    assert.strictEqual(error._tag, "AnnotatorServerError");
    if (error._tag === "AnnotatorServerError") assert.match(error.logPath, /server\.log$/);
  }),
);

it.effect("refuses a project this server does not have", () =>
  Effect.gen(function* () {
    const error = yield* runService({
      action: "status",
      clientHost: undefined,
      stdout: "",
      known: false,
    }).pipe(Effect.flip);
    assert.strictEqual(error._tag, "AnnotatorProjectNotFoundError");
  }),
);
