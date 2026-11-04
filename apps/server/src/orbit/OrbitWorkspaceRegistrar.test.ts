import { assert, describe, it } from "@effect/vitest";
import {
  type OrbitWorkspaceRegisterInput,
  type OrbitWorkspaceRegistration,
  ThreadId,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";

import * as ServerConfig from "../config.ts";
import * as Orchestrator from "../orchestration-v2/Orchestrator.ts";
import {
  OrbitGateway,
  type OrbitGatewayRequest,
  type OrbitGatewayResponse,
} from "./OrbitGateway.ts";
import * as OrbitWorkspaceRegistrar from "./OrbitWorkspaceRegistrar.ts";

const threadId = ThreadId.make("thread-hauzer");

const input: OrbitWorkspaceRegisterInput = {
  threadId,
  instanceName: "t3-7234a69d",
  orbitProjectId: 16,
  projectSlug: "hauzer",
  tld: "test",
  checkoutPath: "/fast/apps/hauzer/t3-7234a69d",
  temporaryBranch: "t3/7234a69d",
};

const ok = (status: number, data: unknown): OrbitGatewayResponse => ({ status, body: { data } });
const refused = (status: number, code: string, message = "Refused."): OrbitGatewayResponse => ({
  status,
  body: { status, error: { code, message, details: [] } },
});

/** A scripted Gateway: each path answers with the next response in its list. */
function fakeGateway(script: Record<string, Array<OrbitGatewayResponse>>) {
  const requests: Array<OrbitGatewayRequest> = [];
  const request = (req: OrbitGatewayRequest) =>
    Effect.sync(() => {
      requests.push(req);
      const queue = script[`${req.method} ${req.path}`];
      const next = queue?.length === 1 ? queue[0] : queue?.shift();
      if (next === undefined) throw new Error(`Unscripted ${req.method} ${req.path}`);
      return next;
    });
  return { requests, request };
}

interface Harness {
  readonly thread: { branch: string | null; title: string };
  readonly gateway: ReturnType<typeof fakeGateway>;
}

/**
 * Files in memory: real file I/O would finish outside the TestClock, so a test could
 * not tell when the registrar reaches its next wait. A restart reuses the same files.
 */
function memoryFiles() {
  const files = new Map<string, string>();
  return FileSystem.layerNoop({
    makeDirectory: () => Effect.void,
    exists: (path) => Effect.succeed(files.has(path)),
    readDirectory: (directory) =>
      Effect.succeed(
        [...files.keys()]
          .filter((path) => path.startsWith(`${directory}/`))
          .map((path) => path.slice(directory.length + 1)),
      ),
    readFileString: (path) => Effect.succeed(files.get(path) ?? ""),
    writeFileString: (path, data) => Effect.sync(() => void files.set(path, data)),
    rename: (from, to) =>
      Effect.sync(() => {
        files.set(to, files.get(from) ?? "");
        files.delete(from);
      }),
    remove: (path) => Effect.sync(() => void files.delete(path)),
  });
}

/** Builds the registrar in the current scope, as a server start would. */
const startRegistrar = (files: ReturnType<typeof memoryFiles>, harness: Harness) =>
  Layer.build(
    OrbitWorkspaceRegistrar.layer.pipe(
      Layer.provide(
        Layer.mergeAll(
          Layer.mock(OrbitGateway)({ request: harness.gateway.request }),
          Layer.mock(Orchestrator.OrchestratorV2)({
            getThreadShell: () => Effect.succeed({ ...harness.thread } as never),
          }),
          Layer.succeed(ServerConfig.ServerConfig, {
            stateDir: "/state",
          } as ServerConfig.ServerConfig["Service"]),
          files,
          Path.layer,
        ),
      ),
    ),
  ).pipe(Effect.map(Context.get(OrbitWorkspaceRegistrar.OrbitWorkspaceRegistrar)));

/** The thread's registration once it is `registered` or `failed`. */
const settled = (registrar: OrbitWorkspaceRegistrar.OrbitWorkspaceRegistrar["Service"]) =>
  registrar.subscribe.pipe(
    Stream.map((list) => list.registrations.find((entry) => entry.threadId === threadId)),
    Stream.filter(
      (entry): entry is OrbitWorkspaceRegistration =>
        entry?.phase === "registered" || entry?.phase === "failed",
    ),
    Stream.runHead,
    Effect.map(Option.getOrThrow),
  );

const posts = (harness: Harness) =>
  harness.gateway.requests.filter((request) => request.method === "POST");

const renamedThread = () => ({ branch: "t3/ui-refinement", title: "Orbit UI Refinement" });

describe("OrbitWorkspaceRegistrar", () => {
  it.effect("waits for the branch rename, then registers under the new name (201)", () =>
    Effect.gen(function* () {
      const harness: Harness = {
        thread: { branch: "t3/7234a69d", title: "New thread" },
        gateway: fakeGateway({
          "POST /api/v1/instances/register": [
            ok(201, { id: 91, url: "https://ui-refinement.hauzer.test" }),
          ],
        }),
      };
      const registrar = yield* startRegistrar(memoryFiles(), harness);
      const started = yield* registrar.register(input);
      assert.strictEqual(started.phase, "waiting");
      assert.strictEqual(started.gatewayUrl, "https://gateway.orbit");

      yield* TestClock.adjust("10 seconds");
      assert.deepStrictEqual(posts(harness), []);

      Object.assign(harness.thread, renamedThread());
      const done = yield* Effect.forkChild(settled(registrar));
      yield* TestClock.adjust("2 seconds");
      const registration = yield* Fiber.join(done);

      assert.strictEqual(registration.phase, "registered");
      assert.strictEqual(registration.instanceId, 91);
      assert.strictEqual(registration.url, "https://ui-refinement.hauzer.test");
      const [post] = posts(harness);
      assert.deepStrictEqual(post?.body, {
        source_path: "/fast/apps/hauzer/t3-7234a69d",
        project_id: 16,
        instance_name: "t3-7234a69d",
        domain: "ui-refinement.hauzer.test",
        setup: true,
      });
      assert.match(post?.idempotencyKey ?? "", /^conn-thread-hauzer-[0-9a-z]+-1$/);
    }).pipe(Effect.scoped),
  );

  it.effect("registers anyway a minute after a branch that never got its name", () =>
    Effect.gen(function* () {
      const harness: Harness = {
        thread: { branch: "t3/7234a69d", title: "Fix the login redirect" },
        gateway: fakeGateway({ "POST /api/v1/instances/register": [ok(201, { id: 5 })] }),
      };
      const registrar = yield* startRegistrar(memoryFiles(), harness);
      yield* registrar.register(input);
      const done = yield* Effect.forkChild(settled(registrar));
      yield* TestClock.adjust("59 seconds");
      assert.deepStrictEqual(posts(harness), []);
      yield* TestClock.adjust("1 second");
      const registration = yield* Fiber.join(done);

      assert.strictEqual(registration.phase, "registered");
      assert.strictEqual(registration.url, null);
      assert.strictEqual(registration.domain, "fix-the-login-redirect.hauzer.test");
    }).pipe(Effect.scoped),
  );

  it.effect("follows a 202 Operation until it succeeds, then reads the Instance", () =>
    Effect.gen(function* () {
      const queued = { id: 4508, status: "queued", target_id: 91, poll_after_seconds: 3 };
      const harness: Harness = {
        thread: renamedThread(),
        gateway: fakeGateway({
          "POST /api/v1/instances/register": [ok(202, queued)],
          "GET /api/v1/operations/4508": [
            ok(200, { ...queued, status: "running" }),
            ok(200, { ...queued, status: "succeeded", poll_after_seconds: null }),
          ],
          "GET /api/v1/instances/91": [
            ok(200, { id: 91, url: "https://ui-refinement.hauzer.test" }),
          ],
        }),
      };
      const registrar = yield* startRegistrar(memoryFiles(), harness);
      const done = yield* Effect.forkChild(settled(registrar));
      yield* registrar.register(input);
      yield* TestClock.adjust("10 seconds");
      const registration = yield* Fiber.join(done);

      assert.strictEqual(registration.phase, "registered");
      assert.strictEqual(registration.operationId, 4508);
      assert.strictEqual(registration.url, "https://ui-refinement.hauzer.test");
      assert.deepStrictEqual(
        harness.gateway.requests.map((request) => `${request.method} ${request.path}`),
        [
          "POST /api/v1/instances/register",
          "GET /api/v1/operations/4508",
          "GET /api/v1/operations/4508",
          "GET /api/v1/instances/91",
        ],
      );
    }).pipe(Effect.scoped),
  );

  it.effect("tries the next domain when Orbit reports the route domain taken", () =>
    Effect.gen(function* () {
      const harness: Harness = {
        thread: renamedThread(),
        gateway: fakeGateway({
          "POST /api/v1/instances/register": [
            refused(422, "route.domain_conflict"),
            refused(422, "route.domain_conflict"),
            ok(201, { id: 92, url: "https://ui-refinement-3.hauzer.test" }),
          ],
        }),
      };
      const registrar = yield* startRegistrar(memoryFiles(), harness);
      const done = yield* Effect.forkChild(settled(registrar));
      yield* registrar.register(input);
      const registration = yield* Fiber.join(done);

      assert.strictEqual(registration.phase, "registered");
      assert.deepStrictEqual(
        posts(harness).map((post) => [
          (post.body as { domain: string }).domain,
          post.idempotencyKey?.slice(-2),
        ]),
        [
          ["ui-refinement.hauzer.test", "-1"],
          ["ui-refinement-2.hauzer.test", "-2"],
          ["ui-refinement-3.hauzer.test", "-3"],
        ],
      );
    }).pipe(Effect.scoped),
  );

  it.effect("tries a 502 or 504 again after 30 seconds", () =>
    Effect.gen(function* () {
      const harness: Harness = {
        thread: renamedThread(),
        gateway: fakeGateway({
          "POST /api/v1/instances/register": [
            refused(502, "http.502"),
            refused(504, "http.504"),
            ok(201, { id: 93, url: null }),
          ],
        }),
      };
      const registrar = yield* startRegistrar(memoryFiles(), harness);
      const done = yield* Effect.forkChild(settled(registrar));
      yield* registrar.register(input);
      yield* TestClock.adjust("29 seconds");
      assert.strictEqual(posts(harness).length, 1);
      yield* TestClock.adjust("31 seconds");
      const registration = yield* Fiber.join(done);
      assert.strictEqual(registration.phase, "registered");
      assert.strictEqual(posts(harness).length, 3);
    }).pipe(Effect.scoped),
  );

  it.effect("stops at Orbit's final answers and shows the code, message and step", () =>
    Effect.gen(function* () {
      const cases = [
        {
          answer: [
            refused(
              503,
              "operation.kind_unavailable",
              "Native registration currently requires no Route, no worktrees and no setup.",
            ),
          ],
          failure: {
            code: "operation.kind_unavailable",
            message: "Native registration currently requires no Route, no worktrees and no setup.",
          },
        },
        {
          answer: [refused(503, "gateway.maintenance", "The Gateway is being released.")],
          failure: { code: "gateway.maintenance", message: "The Gateway is being released." },
        },
        {
          answer: [refused(500, "server.error", "Something broke.")],
          failure: { code: "server.error", message: "Something broke." },
        },
        {
          answer: [refused(422, "validation.failed", "The source path is not a checkout.")],
          failure: { code: "validation.failed", message: "The source path is not a checkout." },
        },
      ];
      for (const { answer, failure } of cases) {
        const harness: Harness = {
          thread: renamedThread(),
          gateway: fakeGateway({ "POST /api/v1/instances/register": answer }),
        };
        const registrar = yield* startRegistrar(memoryFiles(), harness);
        const done = yield* Effect.forkChild(settled(registrar));
        yield* registrar.register(input);
        const registration = yield* Fiber.join(done);
        assert.strictEqual(registration.phase, "failed");
        assert.deepStrictEqual(registration.failure, failure);
        assert.strictEqual(posts(harness).length, 1);
      }

      const harness: Harness = {
        thread: renamedThread(),
        gateway: fakeGateway({
          "POST /api/v1/instances/register": [
            ok(202, { id: 7, status: "running", target_id: 9, poll_after_seconds: 1 }),
          ],
          "GET /api/v1/operations/7": [
            ok(200, {
              id: 7,
              status: "failed",
              error_code: "setup.step_failed",
              failed_step: "composer-install",
            }),
          ],
        }),
      };
      const registrar = yield* startRegistrar(memoryFiles(), harness);
      const done = yield* Effect.forkChild(settled(registrar));
      yield* registrar.register(input);
      yield* TestClock.adjust("1 second");
      const registration = yield* Fiber.join(done);
      assert.deepStrictEqual(registration.failure, {
        code: "setup.step_failed",
        message: "Orbit registration Operation 7 failed at composer-install.",
        step: "composer-install",
      });
    }).pipe(Effect.scoped),
  );

  it.effect("resumes an admitted Operation after a restart without registering again", () =>
    Effect.gen(function* () {
      const files = memoryFiles();
      const running = { id: 4525, status: "running", target_id: 94, poll_after_seconds: 5 };
      const harness: Harness = {
        thread: renamedThread(),
        gateway: fakeGateway({
          "POST /api/v1/instances/register": [ok(202, running)],
          "GET /api/v1/operations/4525": [
            ok(200, running),
            ok(200, { ...running, status: "succeeded" }),
          ],
          "GET /api/v1/instances/94": [
            ok(200, { id: 94, url: "https://ui-refinement.hauzer.test" }),
          ],
        }),
      };
      yield* Effect.gen(function* () {
        const registrar = yield* startRegistrar(files, harness);
        yield* registrar.register(input);
        yield* TestClock.adjust("1 second");
      }).pipe(Effect.scoped);
      assert.strictEqual(posts(harness).length, 1);

      const restarted = yield* startRegistrar(files, harness);
      const done = yield* Effect.forkChild(settled(restarted));
      yield* TestClock.adjust("5 seconds");
      const registration = yield* Fiber.join(done);
      assert.strictEqual(registration.phase, "registered");
      assert.strictEqual(registration.instanceId, 94);
      assert.strictEqual(posts(harness).length, 1);
    }).pipe(Effect.scoped),
  );
});
