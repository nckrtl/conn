import {
  type OrbitWorkspaceFailure,
  type OrbitWorkspaceList,
  type OrbitWorkspaceRegisterInput,
  OrbitWorkspaceRegistration,
  OrbitWorkspaceStoreError,
  ThreadId,
} from "@t3tools/contracts";
import { isTemporaryWorktreeBranch } from "@t3tools/shared/git";
import { orbitRouteSlug, orbitRouteSlugAttempt } from "@t3tools/shared/orbit";
import * as Cause from "effect/Cause";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Data from "effect/Data";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FiberMap from "effect/FiberMap";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as PubSub from "effect/PubSub";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";

import { ServerConfig } from "../config.ts";
import * as Orchestrator from "../orchestration-v2/Orchestrator.ts";
import {
  DEFAULT_ORBIT_GATEWAY_URL,
  OrbitGateway,
  type OrbitGatewayRequest,
  type OrbitGatewayResponse,
} from "./OrbitGateway.ts";

// Fork patch: plain files, not SQLite, because fork migration ids collide with upstream's.
// One `<threadId>.json` per thread under `<stateDir>/orbit-workspaces`.

/** How long to wait for T3's readable branch name before registering anyway. */
const BRANCH_NAME_WAIT_MS = 60_000;
const BRANCH_CHECK_INTERVAL_MS = 2_000;
/** An unreachable Gateway, a 502 or a 504: try again this often, this many times. */
const TRANSIENT_RETRY_INTERVAL_MS = 30_000;
const TRANSIENT_ATTEMPTS = 10;
const OPERATION_WAIT_MS = 30 * 60_000;
const DEFAULT_POLL_AFTER_SECONDS = 2;
const ROUTE_SUFFIX_ATTEMPTS = 5;

// Only a proxy between us and the Gateway answers 502 or 504. Any other status, a 500 or a
// 503 such as `operation.kind_unavailable` included, is the Gateway's answer and is final.
const TRANSIENT_STATUSES = new Set([502, 504]);

const decodeRecord = Schema.decodeUnknownEffect(Schema.fromJsonString(OrbitWorkspaceRegistration));
const encodeRecord = Schema.encodeEffect(Schema.fromJsonString(OrbitWorkspaceRegistration));

export class OrbitWorkspaceRegistrar extends Context.Service<
  OrbitWorkspaceRegistrar,
  {
    /** The list on subscribe, then the full list after every change. */
    readonly subscribe: Stream.Stream<OrbitWorkspaceList, OrbitWorkspaceStoreError>;
    /** Starts a registration; returns an unfinished or finished one as is, and retries a failed one. */
    readonly register: (
      input: OrbitWorkspaceRegisterInput,
    ) => Effect.Effect<OrbitWorkspaceRegistration, OrbitWorkspaceStoreError>;
    readonly remove: (threadId: ThreadId) => Effect.Effect<void, OrbitWorkspaceStoreError>;
  }
>()("t3/orbit/OrbitWorkspaceRegistrar") {}

class RegistrationFailed extends Data.TaggedError("RegistrationFailed")<OrbitWorkspaceFailure> {}

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function text(value: unknown): string | null {
  return typeof value === "string" && value.trim() !== "" ? value : null;
}

function int(value: unknown): number | null {
  return typeof value === "number" && Number.isInteger(value) ? value : null;
}

const invalid = (what: string) =>
  new RegistrationFailed({
    code: "orbit.response_invalid",
    message: `Orbit sent an invalid ${what}.`,
  });

/** The API error envelope `{ error: { code, message } }`, or the bare HTTP status. */
function answerFailure(response: OrbitGatewayResponse): OrbitWorkspaceFailure {
  const error = record(record(response.body)?.error);
  return {
    code: text(error?.code) ?? `http.${response.status}`,
    message: text(error?.message) ?? `Orbit answered with HTTP ${response.status}.`,
  };
}

const isTransient = (response: OrbitGatewayResponse) => TRANSIENT_STATUSES.has(response.status);

const responseData = (response: OrbitGatewayResponse) => record(response.body)?.data;

interface RegistrationOperation {
  readonly id: number;
  readonly status: string;
  readonly instanceId: number | null;
  readonly pollAfterSeconds: number;
  readonly errorCode: string | null;
  readonly failedStep: string | null;
}

const PENDING_STATUSES = new Set(["queued", "running", "waiting"]);
const OPERATION_STATUSES = new Set([...PENDING_STATUSES, "succeeded", "failed", "cancelled"]);

function parseOperation(value: unknown): RegistrationOperation | null {
  const data = record(value);
  const id = int(data?.id);
  const status = text(data?.status);
  if (id === null || id < 1 || status === null || !OPERATION_STATUSES.has(status)) return null;
  return {
    id,
    status,
    instanceId: int(data?.target_id) ?? int(record(data?.result)?.instance_id),
    pollAfterSeconds: Math.max(1, int(data?.poll_after_seconds) ?? DEFAULT_POLL_AFTER_SECONDS),
    errorCode: text(data?.error_code),
    failedStep: text(data?.failed_step),
  };
}

function parseInstance(
  value: unknown,
): { readonly id: number; readonly url: string | null } | null {
  const data = record(value);
  const id = int(data?.id);
  return id === null ? null : { id, url: text(data?.url) };
}

const make = Effect.gen(function* () {
  const config = yield* ServerConfig;
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const gateway = yield* OrbitGateway;
  const orchestrator = yield* Orchestrator.OrchestratorV2;

  const directory = path.join(config.stateDir, "orbit-workspaces");
  const fileFor = (threadId: string) =>
    path.join(directory, `${threadId.replace(/[^A-Za-z0-9._-]/g, "_")}.json`);
  const records = new Map<ThreadId, OrbitWorkspaceRegistration>();
  const changes = yield* PubSub.unbounded<void>();
  const lock = yield* Semaphore.make(1);
  const runs = yield* FiberMap.make<ThreadId>();

  const storeError = (reason: string) => (cause: unknown) =>
    new OrbitWorkspaceStoreError({ reason, cause });

  const nowIso = Clock.currentTimeMillis.pipe(
    Effect.map((millis) => DateTime.formatIso(DateTime.makeUnsafe(millis))),
  );

  const list = Effect.sync((): OrbitWorkspaceList => ({
    registrations: [...records.values()].toSorted((a, b) => a.createdAt.localeCompare(b.createdAt)),
  }));

  const write = Effect.fn("OrbitWorkspaceRegistrar.write")(
    function* (next: OrbitWorkspaceRegistration) {
      const file = fileFor(next.threadId);
      yield* fs.writeFileString(`${file}.tmp`, yield* encodeRecord(next));
      yield* fs.rename(`${file}.tmp`, file);
      records.set(next.threadId, next);
      yield* PubSub.publish(changes, undefined);
      return next;
    },
    Effect.mapError(storeError("Could not save the Orbit registration.")),
  );

  /** Applies a change to the stored record, unless the thread's registration was removed. */
  const update = (
    threadId: ThreadId,
    patch: Partial<Omit<OrbitWorkspaceRegistration, "threadId">>,
  ) =>
    lock.withPermit(
      Effect.gen(function* () {
        const current = records.get(threadId);
        if (current === undefined) return yield* Effect.interrupt;
        return yield* write({ ...current, ...patch, updatedAt: yield* nowIso });
      }),
    );

  const fail = (failure: OrbitWorkspaceFailure) => new RegistrationFailed(failure);

  /** One Gateway call; an unreachable Gateway, a 502 or a 504 is tried again for a while. */
  const call = Effect.fn("OrbitWorkspaceRegistrar.call")(function* (request: OrbitGatewayRequest) {
    for (let attempt = 1; ; attempt += 1) {
      const result = yield* Effect.result(gateway.request(request));
      if (Result.isSuccess(result) && !isTransient(result.success)) return result.success;
      if (attempt >= TRANSIENT_ATTEMPTS) {
        return yield* fail(
          Result.isSuccess(result)
            ? answerFailure(result.success)
            : { code: "orbit.unreachable", message: result.failure.message },
        );
      }
      yield* Effect.logWarning("Orbit registration call failed; trying again", {
        path: request.path,
        attempt,
        ...(Result.isSuccess(result)
          ? answerFailure(result.success)
          : { message: result.failure.message }),
      });
      yield* Effect.sleep(TRANSIENT_RETRY_INTERVAL_MS);
    }
  });

  const readThread = (threadId: ThreadId) =>
    orchestrator.getThreadShell(threadId).pipe(
      Effect.map((shell) => (shell === null ? null : { branch: shell.branch, title: shell.title })),
      Effect.orElseSucceed(() => null),
    );

  /** T3 renames the temporary branch after the first message; wait up to a minute for it. */
  const waitForBranch = Effect.fn("OrbitWorkspaceRegistrar.waitForBranch")(function* (
    registration: OrbitWorkspaceRegistration,
  ) {
    const deadline = Date.parse(registration.createdAt) + BRANCH_NAME_WAIT_MS;
    while (true) {
      const thread = yield* readThread(registration.threadId);
      if (thread?.branch && !isTemporaryWorktreeBranch(thread.branch)) return thread;
      const remaining = deadline - (yield* Clock.currentTimeMillis);
      if (remaining <= 0) return thread;
      yield* Effect.sleep(Math.min(remaining, BRANCH_CHECK_INTERVAL_MS));
    }
  });

  const finishWithInstance = Effect.fn("OrbitWorkspaceRegistrar.finishWithInstance")(function* (
    threadId: ThreadId,
    instanceId: number,
    gatewayUrl: string,
  ) {
    const response = yield* call({
      gatewayUrl,
      method: "GET",
      path: `/api/v1/instances/${instanceId}`,
    });
    // The Instance exists either way; only its URL may be missing.
    const instance = response.status === 200 ? parseInstance(responseData(response)) : null;
    yield* update(threadId, {
      phase: "registered",
      instanceId,
      url: instance?.url ?? null,
      failure: null,
    });
  });

  const followOperation = Effect.fn("OrbitWorkspaceRegistrar.followOperation")(function* (
    threadId: ThreadId,
    gatewayUrl: string,
    admitted: RegistrationOperation | null,
    operationId: number,
  ) {
    const deadline = (yield* Clock.currentTimeMillis) + OPERATION_WAIT_MS;
    let operation = admitted;
    while (operation === null || PENDING_STATUSES.has(operation.status)) {
      if (operation !== null) {
        const remaining = deadline - (yield* Clock.currentTimeMillis);
        if (remaining <= 0) {
          return yield* fail({
            code: "orbit.operation_pending",
            message: `Orbit registration Operation ${operationId} is still ${operation.status}.`,
          });
        }
        yield* Effect.sleep(Math.min(operation.pollAfterSeconds * 1000, remaining));
      }
      const response = yield* call({
        gatewayUrl,
        method: "GET",
        path: `/api/v1/operations/${operationId}`,
      });
      if (response.status !== 200) return yield* fail(answerFailure(response));
      operation = parseOperation(responseData(response));
      if (operation === null || operation.id !== operationId) {
        return yield* invalid("registration Operation");
      }
    }
    if (operation.status !== "succeeded") {
      return yield* fail({
        code: operation.errorCode ?? `operation.${operation.status}`,
        message: `Orbit registration Operation ${operationId} ${operation.status}${
          operation.failedStep ? ` at ${operation.failedStep}` : ""
        }.`,
        ...(operation.failedStep ? { step: operation.failedStep } : {}),
      });
    }
    if (operation.instanceId === null) return yield* invalid("registration Operation");
    yield* finishWithInstance(threadId, operation.instanceId, gatewayUrl);
  });

  const registerWithOrbit = Effect.fn("OrbitWorkspaceRegistrar.registerWithOrbit")(function* (
    registration: OrbitWorkspaceRegistration,
    thread: { readonly branch: string | null; readonly title: string } | null,
  ) {
    const { threadId, gatewayUrl } = registration;
    const slug = orbitRouteSlug({
      branch: thread?.branch ?? registration.temporaryBranch,
      title: thread?.title ?? null,
      instanceName: registration.instanceName,
    });
    for (let attempt = 1; ; attempt += 1) {
      const domain = `${orbitRouteSlugAttempt(slug, attempt)}.${registration.projectSlug}.${registration.tld}`;
      yield* update(threadId, { domain });
      const response = yield* call({
        gatewayUrl,
        method: "POST",
        path: "/api/v1/instances/register",
        body: {
          source_path: registration.checkoutPath,
          project_id: registration.orbitProjectId,
          instance_name: registration.instanceName,
          domain,
          setup: true,
        },
        ...(registration.requestKey
          ? { idempotencyKey: `${registration.requestKey}-${attempt}` }
          : {}),
      });
      if (response.status === 201) {
        const instance = parseInstance(responseData(response));
        if (instance === null) return yield* invalid("Instance");
        return yield* update(threadId, {
          phase: "registered",
          instanceId: instance.id,
          url: instance.url,
          failure: null,
        });
      }
      if (response.status === 202) {
        const operation = parseOperation(responseData(response));
        if (operation === null) return yield* invalid("registration Operation");
        yield* update(threadId, { operationId: operation.id });
        return yield* followOperation(threadId, gatewayUrl, operation, operation.id);
      }
      const failure = answerFailure(response);
      const taken = response.status === 422 && failure.code === "route.domain_conflict";
      if (!taken || attempt === ROUTE_SUFFIX_ATTEMPTS) return yield* fail(failure);
    }
  });

  const run = Effect.fn("OrbitWorkspaceRegistrar.run")(
    function* (threadId: ThreadId) {
      let registration = records.get(threadId);
      if (registration === undefined) return;
      if (registration.phase === "registering" && registration.operationId !== null) {
        return yield* followOperation(
          threadId,
          registration.gatewayUrl,
          null,
          registration.operationId,
        );
      }
      const thread =
        registration.phase === "waiting"
          ? yield* waitForBranch(registration)
          : yield* readThread(threadId);
      registration = yield* update(threadId, { phase: "registering" });
      yield* registerWithOrbit(registration, thread);
    },
    (effect, threadId) =>
      effect.pipe(
        Effect.catchTags({
          RegistrationFailed: (failure) =>
            update(threadId, {
              phase: "failed",
              failure: {
                code: failure.code,
                message: failure.message,
                ...(failure.step ? { step: failure.step } : {}),
              },
            }),
        }),
        Effect.catchCause((cause) =>
          Cause.hasInterruptsOnly(cause)
            ? Effect.interrupt
            : update(threadId, {
                phase: "failed",
                failure: { code: "conn.registration_error", message: Cause.pretty(cause) },
              }).pipe(Effect.ignore),
        ),
      ),
  );

  const start = (threadId: ThreadId) => FiberMap.run(runs, threadId, run(threadId));

  const register: OrbitWorkspaceRegistrar["Service"]["register"] = Effect.fn(
    "OrbitWorkspaceRegistrar.register",
  )(function* (input) {
    const existing = records.get(input.threadId);
    if (existing !== undefined && existing.phase !== "failed") return existing;
    const now = yield* nowIso;
    const millis = yield* Clock.currentTimeMillis;
    // One key per attempt: a retry after a failure must not get the failed Operation back.
    const requestKey = `conn-${input.threadId.replace(/[^A-Za-z0-9._:-]/g, "_")}-${millis.toString(36)}`;
    const next = yield* lock.withPermit(
      write(
        existing === undefined
          ? {
              ...input,
              gatewayUrl: input.gatewayUrl?.trim() || DEFAULT_ORBIT_GATEWAY_URL,
              phase: "waiting",
              createdAt: now,
              updatedAt: now,
              domain: null,
              operationId: null,
              requestKey,
              instanceId: null,
              url: null,
              failure: null,
            }
          : {
              ...existing,
              phase: "registering",
              updatedAt: now,
              operationId: null,
              requestKey,
              failure: null,
            },
      ),
    );
    yield* start(next.threadId);
    return next;
  });

  const remove: OrbitWorkspaceRegistrar["Service"]["remove"] = Effect.fn(
    "OrbitWorkspaceRegistrar.remove",
  )(function* (threadId) {
    yield* FiberMap.remove(runs, threadId);
    yield* lock.withPermit(
      Effect.gen(function* () {
        if (!records.delete(threadId)) return;
        yield* fs
          .remove(fileFor(threadId), { force: true })
          .pipe(Effect.mapError(storeError("Could not remove the Orbit registration.")));
        yield* PubSub.publish(changes, undefined);
      }),
    );
  });

  const subscribe: OrbitWorkspaceRegistrar["Service"]["subscribe"] = Stream.unwrap(
    Effect.gen(function* () {
      // Subscribe before reading to buffer concurrent changes.
      const subscription = yield* PubSub.subscribe(changes);
      return Stream.concat(
        Stream.fromEffect(list),
        Stream.fromSubscription(subscription).pipe(Stream.mapEffect(() => list)),
      );
    }),
  );

  // Load what an earlier run left, and resume every unfinished registration.
  yield* fs.makeDirectory(directory, { recursive: true }).pipe(Effect.orDie);
  for (const name of yield* fs.readDirectory(directory).pipe(Effect.orDie)) {
    if (!name.endsWith(".json")) continue;
    const loaded = yield* fs.readFileString(path.join(directory, name)).pipe(
      Effect.flatMap(decodeRecord),
      Effect.tapError((cause) =>
        Effect.logWarning("Skipping an unreadable Orbit registration", { name, cause }),
      ),
      Effect.option,
    );
    if (loaded._tag === "Some") records.set(loaded.value.threadId, loaded.value);
  }
  for (const registration of records.values()) {
    if (registration.phase === "waiting" || registration.phase === "registering") {
      yield* start(registration.threadId);
    }
  }

  return OrbitWorkspaceRegistrar.of({ subscribe, register, remove });
});

export const layer = Layer.effect(OrbitWorkspaceRegistrar, make);
