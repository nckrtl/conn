import {
  EnvironmentId,
  ProviderInstanceId,
  ThreadId,
  type OrchestrationV2ArchivedShellSnapshot,
} from "@t3tools/contracts";
import { AsyncResult, Atom, AtomRegistry } from "effect/reactivity";
import { expect, it, vi } from "vite-plus/test";

import {
  createOrbitGatewayClient,
  OrbitGatewayError,
  type OrbitGatewayOperation,
} from "./client.ts";
import {
  createOrbitLaunchSubmissions,
  readLegacyOrbitLaunches,
  recordLegacyOrbitPreview,
  updateLegacyOrbitPreview,
  resolveLegacyOrbitLaunch,
  type OrbitLaunchSubmission,
} from "./launchAdmission.ts";
import { createOrbitLaunchObserver } from "./launchObserver.ts";
import { createOrbitLaunchThreadRowsAtom } from "./launchThreadRows.ts";
import { newOrbitLaunchAdmission, type OrbitLaunch } from "./launches.ts";

import { v2Now, v2ThreadShell } from "../state/orchestrationV2TestFixtures.ts";
import { fitOrbitThreadInstanceName } from "./threadStart.ts";

const pending = { status: "pending", started_at: null, finished_at: null, error: null } as const;
const unavailable = { available: false, reason: null, requires: null };
const fixture = (patch: Partial<OrbitLaunch> = {}): OrbitLaunch => ({
  id: 41,
  kind: "conn.launch",
  status: "queued",
  created_at: "2026-11-17T12:00:00Z",
  started_at: null,
  finished_at: null,
  cancel_requested: false,
  poll_after_seconds: 10,
  error_code: null,
  launch_id: "launch-id",
  profile_id: 12,
  project_id: 78,
  instance_id: null,
  workspace_id: null,
  target_node_id: 5,
  initiator_node_id: 7,
  source: "mobile",
  phase: "preparing",
  stages: {
    workspace_server: pending,
    first_message: pending,
    publication: pending,
    application_preview: pending,
    cleanup: pending,
  },
  readiness: { workspace_server: null, first_message: null, application_preview: null },
  actions: {
    cancel: { ...unavailable, available: true },
    retry_launch: unavailable,
    retry_application: unavailable,
  },
  children: {
    create_operation_id: null,
    wake_operation_id: null,
    completion_operation_id: null,
    destroy_operation_id: null,
  },
  thread: null,
  ...patch,
});

const request = newOrbitLaunchAdmission(
  (() => {
    const ids = ["launch-id", "command-id", "thread-id", "message-id"];
    return () => ids.shift()!;
  })(),
  { nodeId: 7, profileId: 12 },
  {
    project_id: 78,
    workspace_id: "workspace",
    target: { kind: "new", name: "new", branch: { mode: "new", from: "main" } },
    prompt: "Build the feature",
    source: "mobile",
    runtime_mode: "approval-required",
  },
);
const wrap = (data: unknown, status = 200) => ({
  status,
  body: JSON.stringify({ data, meta: { request_id: "test" } }),
});
const errorResponse = (code: string, status: number) => ({
  status,
  body: JSON.stringify({ error: { code, message: code } }),
});

it("uses the launch key and same IDs, decodes keyed snapshots and sends Orbit's action targets", async () => {
  const original = fixture();
  const finished = fixture({
    phase: "ready",
    readiness: { ...original.readiness, first_message: true },
  });
  const transport = vi
    .fn()
    .mockResolvedValueOnce(wrap(original, 202))
    .mockResolvedValueOnce(wrap([original]))
    .mockResolvedValueOnce(wrap(finished))
    .mockResolvedValueOnce(wrap(finished, 202))
    .mockResolvedValueOnce(wrap(fixture({ phase: "cancelling", cancel_requested: true }), 202));
  const api = createOrbitGatewayClient(transport).launches;

  expect(await api.submit(request)).toEqual(original);
  expect(transport).toHaveBeenNthCalledWith(1, {
    method: "POST",
    path: "/launches",
    idempotencyKey: "launch-id",
    timeoutMs: 60_000,
    body: {
      ...request.request,
      command_id: "command-id",
      thread_id: "thread-id",
      message_id: "message-id",
    },
  });
  expect(await api.list()).toEqual([original]);
  expect(await api.read(41)).toEqual(finished);
  await api.retry(41, "application");
  expect(transport).toHaveBeenNthCalledWith(4, {
    method: "POST",
    path: "/launches/41/retry",
    body: { target: "application" },
  });
  expect((await api.cancel(41)).phase).toBe("cancelling");
  expect(transport).toHaveBeenNthCalledWith(5, { method: "POST", path: "/launches/41/cancel" });
});

it("recovers a lost admission reply and a restart by reading the accepted launch before resending", async () => {
  const admitted = fixture();
  let rows: readonly OrbitLaunch[] = [];
  let stored: readonly OrbitLaunchSubmission[] = [];
  const transport = vi.fn(async ({ method, path }: { method: string; path: string }) => {
    if (path === "/me")
      return wrap({
        id: 7,
        name: "initiator",
        profile: {
          id: 12,
          name: "Work",
          settings_version: 1,
          updated_at: "2026-11-17T12:00:00Z",
        },
      });
    if (method === "GET") return wrap(rows);
    rows = [admitted];
    throw new Error("Response lost after commit");
  });
  const api = createOrbitGatewayClient(transport);
  const storage = {
    load: async () => stored,
    save: async (next: readonly OrbitLaunchSubmission[]) => {
      stored = next;
    },
  };
  const setup = () => {
    const observer = createOrbitLaunchObserver(() => api);
    observer.setScope({ nodeId: 7, profileId: 12 });
    return {
      observer,
      journal: createOrbitLaunchSubmissions(storage, (row, reconcile) =>
        observer.submit(row.admission, row, reconcile),
      ),
    };
  };
  const draft = { nodeId: 7, profileId: 12, draftId: "local-draft", admission: request };
  const first = setup();
  try {
    expect(await first.journal.submit(draft)).toEqual(admitted);
  } finally {
    first.observer.setScope(null);
  }
  expect(stored).toEqual([draft]);
  const restarted = setup();
  try {
    expect(
      await restarted.journal.submit({
        ...draft,
        admission: { ...request, id: "would-duplicate" },
      }),
    ).toEqual(admitted);
    expect(transport.mock.calls.filter(([call]) => call.method === "POST")).toHaveLength(1);
    await restarted.journal.acknowledge(request.id);
    expect(stored).toEqual([]);
  } finally {
    restarted.observer.setScope(null);
  }
});

it("replays an unconfirmed submission only on request and with the original key and body", async () => {
  let stored: readonly OrbitLaunchSubmission[] = [];
  const me = wrap({
    id: 7,
    name: "initiator",
    profile: { id: 12, name: "Work", settings_version: 1, updated_at: "2026-11-17T12:00:00Z" },
  });
  const initial = fixture();
  let posts = 0;
  const transport = vi.fn(async ({ method, path }: { method: string; path: string }) => {
    if (path === "/me") return me;
    if (method === "GET") return wrap([]);
    posts += 1;
    if (posts === 1) throw new Error("Connection lost before the server answered");
    return wrap(initial, 202);
  });
  const client = createOrbitGatewayClient(transport);
  const observer = createOrbitLaunchObserver(() => client);
  const scope = { nodeId: 7, profileId: 12 };
  const draft = { ...scope, draftId: "draft", admission: request };
  const journal = createOrbitLaunchSubmissions(
    {
      load: async () => stored,
      save: async (rows) => {
        stored = rows;
      },
    },
    (row, reconcile) => observer.submit(row.admission, row, reconcile),
  );
  observer.setScope(scope);
  try {
    await expect(journal.submit(draft)).rejects.toThrow("did not answer");
    expect(await journal.pending(scope)).toEqual([draft]);
    expect(posts).toBe(1);
    const edited = {
      ...draft,
      admission: { ...request, request: { ...request.request, prompt: "Edited" } },
    };
    await expect(journal.submit(edited)).rejects.toThrow("Resolve the previous Orbit submission");
    expect(await journal.replay(draft)).toEqual(initial);
    const payloads = transport.mock.calls.filter(([call]) => call.method === "POST");
    expect(payloads).toHaveLength(2);
    expect(payloads[1]).toEqual(payloads[0]);
  } finally {
    observer.setScope(null);
  }
});

it("keeps the draft on the original profile and Node after a lost reply", async () => {
  const original = { nodeId: 7, profileId: 12, draftId: "draft", admission: request };
  let stored: readonly OrbitLaunchSubmission[] = [];
  const send = vi.fn().mockRejectedValueOnce(new Error("Reply lost")).mockResolvedValue(fixture());
  const journal = createOrbitLaunchSubmissions(
    {
      load: async () => stored,
      save: async (rows) => {
        stored = rows;
      },
    },
    send,
  );
  await expect(journal.submit(original)).rejects.toThrow("Reply lost");
  for (const scope of [
    { nodeId: 7, profileId: 13 },
    { nodeId: 8, profileId: 12 },
  ]) {
    await expect(
      journal.submit({
        ...original,
        ...scope,
        admission: {
          id: "new-key",
          request: {
            ...request.request,
            expected_node_id: scope.nodeId,
            expected_profile_id: scope.profileId,
          },
        },
      }),
    ).rejects.toThrow("original Orbit profile and device");
    expect(await journal.pending(scope)).toEqual([]);
  }
  expect(send.mock.calls).toEqual([[original, false]]);
  await expect(journal.submit(original)).resolves.toEqual(fixture());
  expect(send.mock.calls[1]).toEqual([original, true]);
});

it("does not rewrite a refused cancel as Cancelling and does not submit a stale-profile draft", async () => {
  const committed = fixture({
    phase: "dispatching",
    profile_id: 1,
    actions: { ...fixture().actions, cancel: unavailable },
  });
  let list = [fixture({ profile_id: 1 })];
  const transport = vi.fn(async ({ method }: { method: string }) =>
    method === "GET" ? wrap(list) : errorResponse("conn.launch_handoff_committed", 409),
  );
  const observer = createOrbitLaunchObserver(() => createOrbitGatewayClient(transport));
  const initialized = Promise.withResolvers<void>();
  const refreshed = Promise.withResolvers<void>();
  const stop = observer.subscribe(() => {
    if (observer.view().loaded) initialized.resolve();
    if (observer.view().launches[0]?.phase === "dispatching") refreshed.resolve();
  });
  observer.setScope({ nodeId: 7, profileId: 1 });
  try {
    await initialized.promise;
    list = [committed];
    await expect(observer.act(41, "cancel")).rejects.toMatchObject<Partial<OrbitGatewayError>>({
      code: "conn.launch_handoff_committed",
      status: 409,
    });
    await refreshed.promise;
    expect(observer.view().launches[0]?.phase).toBe("dispatching");
    await expect(observer.act(41, "cancel")).rejects.toThrow("no longer offers");
    await expect(observer.submit(request, { nodeId: 7, profileId: 2 }, true)).rejects.toThrow(
      "original Orbit profile",
    );
    await expect(observer.submit(request, { nodeId: 9, profileId: 1 }, true)).rejects.toThrow(
      "original Orbit profile and device",
    );
    expect(transport.mock.calls.filter(([call]) => call.method === "POST")).toHaveLength(1);
  } finally {
    stop();
    observer.setScope(null);
  }
});

it("retains newer polled progress when an older action response arrives", async () => {
  const started = Promise.withResolvers<void>();
  const cancel = Promise.withResolvers<ReturnType<typeof wrap>>();
  const initialized = Promise.withResolvers<void>();
  let list = [fixture()];
  const gateway = createOrbitGatewayClient(async ({ method }) => {
    if (method === "GET") return wrap(list);
    started.resolve();
    return cancel.promise;
  });
  const observer = createOrbitLaunchObserver(() => gateway);
  const stop = observer.subscribe(() => {
    if (observer.view().loaded) initialized.resolve();
  });
  observer.setScope({ nodeId: 7, profileId: 12 });
  try {
    await initialized.promise;
    const acting = observer.act(41, "cancel");
    await started.promise;
    list = [fixture({ phase: "cancelled", cancel_requested: true })];
    await observer.refresh();
    cancel.resolve(wrap(fixture({ phase: "cancelling", cancel_requested: true }), 202));
    await acting;
    expect(observer.view().launches[0]?.phase).toBe("cancelled");
  } finally {
    stop();
    observer.setScope(null);
  }
});

it("retains old unsent and ambiguous prompts for manual recovery and never touches opaque rows", () => {
  const unsent = {
    id: "old",
    message: "Recover this",
    threadId: "t-1",
    environmentId: "env-1",
    projectSlug: "Orbit",
  };
  const sent = { ...unsent, id: "sent", sentAt: 123 };
  const opaque = { id: "older", olderShape: true };
  const noRef = { id: "no-ref", message: "An old message" };
  const raw = JSON.stringify([sent, unsent, opaque, noRef]);
  expect(readLegacyOrbitLaunches(raw)).toEqual([
    {
      id: "old",
      prompt: "Recover this",
      threadId: "t-1",
      environmentId: "env-1",
      project: "Orbit",
      completion: null,
    },
    {
      id: "no-ref",
      prompt: "An old message",
      threadId: null,
      environmentId: null,
      project: "Orbit",
      completion: null,
    },
  ]);
  expect(JSON.parse(resolveLegacyOrbitLaunch(raw, "old")!)).toEqual([sent, opaque, noRef]);
});

it("replays the original profile and Node even when the device is rebound after /me", async () => {
  const expected = { nodeId: 7, profileId: 12 };
  let profile = 12;
  let checked = false;
  let admitted = 0;
  const transport = vi.fn(async (call: { path: string; method: string; body?: unknown }) => {
    if (call.path === "/me") {
      checked = true;
      return wrap({
        id: 7,
        name: "Device",
        profile: {
          id: profile,
          name: "Work",
          settings_version: 1,
          updated_at: "2026-11-17T12:00:00Z",
        },
      });
    }
    if (call.method === "GET") {
      if (checked) profile = 13;
      return wrap(profile === 13 ? [fixture({ profile_id: 13, launch_id: "other" })] : []);
    }
    const body = call.body as typeof request.request;
    if (body.expected_profile_id !== profile || body.expected_node_id !== 7) {
      return errorResponse("conn.launch_scope_changed", 409);
    }
    admitted += 1;
    return wrap(fixture({ profile_id: profile }), 202);
  });
  const observer = createOrbitLaunchObserver(() => createOrbitGatewayClient(transport));
  observer.setScope(expected);
  try {
    await expect(observer.submit(request, expected, true)).rejects.toMatchObject({
      code: "conn.launch_scope_changed",
    });
    expect(admitted).toBe(0);
    const post = transport.mock.calls.find(([call]) => call.method === "POST");
    expect(post?.[0]).toMatchObject({ idempotencyKey: request.id, body: request.request });
    await observer.refresh();
    expect(observer.view().launches).toEqual([]);
  } finally {
    observer.setScope(null);
  }
});

it("keeps a refused replay recoverable and allows a corrected Send from the same draft", async () => {
  const scope = { nodeId: 7, profileId: 12 };
  let stored: readonly OrbitLaunchSubmission[] = [];
  const old = { ...scope, draftId: "first-sheet:78", admission: request };
  const next = {
    ...scope,
    draftId: "second-sheet:101",
    admission: { id: "other", request: { ...request.request, project_id: 101 } },
  };
  const submit = vi
    .fn()
    .mockRejectedValueOnce(new Error("The original reply was lost"))
    .mockRejectedValueOnce(
      new OrbitGatewayError({
        code: "validation_failed",
        status: 422,
        message: "Project selection is invalid",
        details: {},
      }),
    )
    .mockResolvedValueOnce(fixture({ launch_id: "other", project_id: 101 }));
  const journal = createOrbitLaunchSubmissions(
    {
      load: async () => stored,
      save: async (rows) => {
        stored = rows;
      },
    },
    submit,
  );
  await expect(journal.submit(old)).rejects.toThrow("original reply");
  const corrected = { ...next, draftId: old.draftId };
  await expect(journal.submit(corrected)).rejects.toThrow("Resolve the previous");
  await expect(journal.replay(old)).rejects.toThrow("Project selection is invalid");
  expect((await journal.submit(corrected)).launch_id).toBe("other");
  expect(await journal.pending(scope)).toEqual([{ ...old, replayRefused: true }, corrected]);
  expect(submit.mock.calls[2]).toEqual([corrected, false]);
});

it("retains unpaired launch links and keeps archived launches off the list after a cold start", () => {
  const initial = fixture();
  const launch = fixture({
    phase: "ready",
    stages: { ...initial.stages, application_preview: { ...pending, status: "skipped" } },
    thread: {
      environment_id: "unpaired",
      project_id: "clone",
      thread_id: "thread-id",
      message_id: "message-id",
      model_selection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt" },
      accepted_at: initial.created_at,
    },
  });
  const environmentId = EnvironmentId.make("unpaired");
  const threadId = ThreadId.make("thread-id");
  const refs = Atom.make<readonly { environmentId: EnvironmentId; threadId: ThreadId }[]>([
    { environmentId: EnvironmentId.make("other"), threadId },
  ]);
  const emptyCatalog = { isReady: true, entries: new Map<EnvironmentId, { enabled: boolean }>() };
  const pairedCatalog = { isReady: true, entries: new Map([[environmentId, { enabled: true }]]) };
  const catalog = Atom.make(emptyCatalog);
  const archive = Atom.make<AsyncResult.AsyncResult<OrchestrationV2ArchivedShellSnapshot, Error>>(
    AsyncResult.initial(true),
  );
  const archiveSnapshot = { schemaVersion: 2, snapshotSequence: 10, projects: [], threads: [] };
  const archived = AsyncResult.success({
    ...archiveSnapshot,
    threads: [{ ...v2ThreadShell, id: threadId, archivedAt: v2Now }],
  });
  const lookupArchive = vi.fn(() => archive);
  let snapshot = { launches: [launch], error: null, loaded: true };
  const onSnapshot = new Set<() => void>();
  const rows = createOrbitLaunchThreadRowsAtom({
    observer: {
      view: () => snapshot,
      subscribe: (listener) => {
        onSnapshot.add(listener);
        return () => {
          onSnapshot.delete(listener);
        };
      },
    },
    threadRefsAtom: refs,
    catalogValueAtom: catalog,
    archivedSnapshotAtom: lookupArchive,
  });
  const registry = AtomRegistry.make();
  const stop = registry.mount(rows);
  expect(registry.get(rows).rows).toEqual([launch]);
  expect(lookupArchive).not.toHaveBeenCalled();
  registry.set(catalog, pairedCatalog);
  registry.set(archive, AsyncResult.success(archiveSnapshot));
  expect(registry.get(rows).rows).toEqual([launch]);
  registry.set(refs, [{ environmentId, threadId }]);
  expect(registry.get(rows).rows).toEqual([]);
  registry.set(refs, []);
  expect(registry.get(rows).rows).toEqual([]);
  expect(registry.get(rows).snapshot.launches).toEqual([launch]);

  const restarted = AtomRegistry.make();
  const stopRestarted = restarted.mount(rows);
  restarted.set(catalog, { ...emptyCatalog, isReady: false });
  expect(restarted.get(rows).rows).toEqual([]);
  restarted.set(catalog, pairedCatalog);
  expect(restarted.get(rows).rows).toEqual([]);
  restarted.set(archive, archived);
  expect(restarted.get(rows).rows).toEqual([]);
  expect(restarted.get(rows).snapshot.launches).toEqual([launch]);
  const failedPreview = {
    ...launch,
    stages: { ...launch.stages, application_preview: { ...pending, status: "failed" as const } },
  };
  snapshot = { ...snapshot, launches: [failedPreview] };
  for (const listener of onSnapshot) listener();
  expect(restarted.get(rows).rows).toEqual([failedPreview]);
  stopRestarted();
  stop();
  restarted.dispose();
  registry.dispose();
});

it("resumes an old preview retry with the saved key when its operation ID was never received", async () => {
  const saved = {
    id: "sent",
    message: "A previously accepted prompt",
    sentAt: 10,
    instanceId: 20,
    completionOperationId: null,
    completionKey: "conn-thread-start:sent:complete:1234",
    completionStatus: "queued",
    completionRetryable: false,
  };
  const raw = JSON.stringify([saved]);
  const row = readLegacyOrbitLaunches(raw)[0]!;
  expect(row.prompt).toBeNull();
  expect(row.completion).toMatchObject({ operationId: null, retryable: true });
  const accepted: OrbitGatewayOperation = {
    id: 34,
    kind: "instance.complete",
    targetId: 20,
    status: "queued",
    errorCode: null,
    pollAfterSeconds: 1,
  };
  const operation = vi.fn().mockResolvedValue(accepted);
  const completeInstance = vi.fn().mockResolvedValue(accepted);
  const client = { operation, completeInstance };
  const retry = await updateLegacyOrbitPreview(client, row.completion!, "retry");
  expect(completeInstance.mock.calls).toEqual([[20, saved.completionKey]]);
  expect(operation).not.toHaveBeenCalled();

  const newer = { ...saved, completionKey: "conn-thread-start:sent:complete:4567" };
  const newerRaw = JSON.stringify([newer]);
  expect(recordLegacyOrbitPreview(newerRaw, row, retry)).toBe(newerRaw);

  const recorded = readLegacyOrbitLaunches(recordLegacyOrbitPreview(raw, row, retry))[0]!;
  expect(recorded.completion).toMatchObject({ operationId: 34, retryable: false });
  await updateLegacyOrbitPreview(client, recorded.completion!, "refresh");
  expect(operation.mock.calls).toEqual([[34]]);
  expect(completeInstance).toHaveBeenCalledTimes(1);
});

it("fits a generated mobile name before the admission body is frozen", async () => {
  const checkInstanceName = vi.fn(async (_project: number, name: string) => ({
    name,
    available: name.length <= 20,
    reason: name.length <= 20 ? null : ("domain_invalid" as const),
    domain: null,
  }));
  const result = await fitOrbitThreadInstanceName(
    { checkInstanceName },
    78,
    "Build an exceptionally complicated multistage integration",
    "abcdef",
  );
  expect(checkInstanceName.mock.calls[0]?.[1]).toHaveLength(47);
  expect(result.length).toBeLessThanOrEqual(20);
  expect(result).toMatch(/-abcdef$/);
  expect(checkInstanceName.mock.calls.map(([id]) => id)).toEqual([78, 78, 78]);
});

it("recovers a legacy preview using only its instance and operation, without the previously sent message", async () => {
  const raw = JSON.stringify([
    {
      id: "sent",
      message: "A previously accepted prompt",
      threadId: "thread-a",
      sentAt: 10,
      instanceId: 20,
      completionOperationId: 30,
      completionStatus: "failed",
      completionRetryable: true,
    },
  ]);
  const row = readLegacyOrbitLaunches(raw)[0]!;
  expect(row.prompt).toBeNull();
  expect(row.completion).toMatchObject({ operationId: 30, retryable: true });
  const failed: OrbitGatewayOperation = {
    id: 30,
    kind: "instance.complete",
    targetId: 20,
    status: "failed",
    errorCode: "preview.failed",
    pollAfterSeconds: null,
    recoveryRetryable: true,
  };
  const operation = vi.fn().mockResolvedValue(failed);
  const completeInstance = vi
    .fn()
    .mockRejectedValueOnce(new Error("Reply lost"))
    .mockResolvedValueOnce({
      ...failed,
      id: 34,
      status: "queued",
      recoveryRetryable: false,
    });
  const client = { operation, completeInstance };
  await expect(updateLegacyOrbitPreview(client, row.completion!, "retry")).rejects.toThrow(
    "Reply lost",
  );
  const retry = await updateLegacyOrbitPreview(client, row.completion!, "retry");
  expect(completeInstance.mock.calls).toEqual([
    [20, "conn:legacy-preview:30"],
    [20, "conn:legacy-preview:30"],
  ]);
  expect(
    readLegacyOrbitLaunches(recordLegacyOrbitPreview(raw, row, retry))[0]?.completion,
  ).toMatchObject({
    operationId: 34,
    status: "queued",
    retryable: false,
  });
});
