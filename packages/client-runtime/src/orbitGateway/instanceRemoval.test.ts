import { describe, expect, it } from "vite-plus/test";

import {
  createOrbitGatewayClient,
  type OrbitGatewayRequest,
  type OrbitGatewayResponse,
} from "./client.ts";
import { parseOrbitInstanceGit } from "./instanceGit.ts";
import {
  DESTROY_TIMEOUT_MS,
  orbitInstanceRemoveText,
  removeOrbitInstance,
  type OrbitInstanceRemoveTarget,
} from "./instanceRemoval.ts";

const op = (status: string, extra: Record<string, unknown> = {}) => ({
  id: 77,
  kind: "instance.destroy",
  status,
  target_id: 41,
  poll_after_seconds: ["succeeded", "failed", "cancelled", "interrupted"].includes(status)
    ? null
    : 2,
  ...extra,
});
const ok = (data: unknown, status = 200): OrbitGatewayResponse => ({
  status,
  body: JSON.stringify({ data }),
});
const error = (status: number, code: string, details: unknown = {}): OrbitGatewayResponse => ({
  status,
  body: JSON.stringify({ error: { code, message: `Orbit says ${code}.`, details } }),
});

/** A Gateway whose answers come from a script, one per request, through the real client. */
function gateway(answers: Array<OrbitGatewayResponse | Error>) {
  const requests: OrbitGatewayRequest[] = [];
  let clock = 0;
  const client = createOrbitGatewayClient(async (request) => {
    requests.push(request);
    const answer = answers.shift();
    if (answer === undefined) throw new Error("no more answers");
    if (answer instanceof Error) throw answer;
    return answer;
  });
  const ports = {
    client,
    now: () => clock,
    sleep: async (ms: number) => {
      clock += ms;
    },
  };
  const remove = (acknowledgeUnsaved = false, git = parseOrbitInstanceGit(undefined)) =>
    removeOrbitInstance(ports, {
      instanceId: 41,
      acknowledgeUnsaved,
      idempotencyKey: "key-1",
      ...(git ? { git } : {}),
    });
  return { requests, remove, elapsed: () => clock };
}

describe("removeOrbitInstance", () => {
  it("sends the destroy with its key and tick, then follows the Operation to its end", async () => {
    const orbit = gateway([ok(op("queued"), 202), ok(op("running")), ok(op("succeeded"))]);
    expect(await orbit.remove(true)).toEqual({ kind: "removed" });
    expect(orbit.requests.map((request) => `${request.method} ${request.path}`)).toEqual([
      "POST /instances/41/destroy",
      "GET /operations/77",
      "GET /operations/77",
    ]);
    expect(orbit.requests[0]).toMatchObject({
      body: { acknowledge_unsaved: true },
      idempotencyKey: "key-1",
    });
  });

  it.each(["http.404", "instance.not_found", "anything.else"])(
    "treats any 404 (%s) as an Instance that is already removed",
    async (code) => {
      const orbit = gateway([error(404, code)]);
      expect(await orbit.remove()).toEqual({ kind: "removed" });
      expect(orbit.requests).toHaveLength(1);
    },
  );

  it("returns the first release's unknown state without the tick, so the dialog asks for it", async () => {
    const orbit = gateway([
      error(409, "instance.unsaved_work", { state: "unknown", uncommitted: null, unpushed: null }),
    ]);
    expect(await orbit.remove(false)).toEqual({
      kind: "unsaved_work",
      git: { state: "unknown", reason: null },
    });
    expect(orbit.requests).toHaveLength(1);
  });

  it("returns Orbit's unsaved work without the tick, so the dialog can ask for it", async () => {
    const orbit = gateway([
      error(409, "instance.unsaved_work", { uncommitted: 3, unpushed: null, state: "dirty" }),
    ]);
    const listed = parseOrbitInstanceGit({
      state: "known",
      branch: "pricing-page",
      uncommitted: 0,
      unpushed: 2,
    });
    expect(await orbit.remove(false, listed)).toEqual({
      kind: "unsaved_work",
      git: expect.objectContaining({ state: "known", uncommitted: 3, unpushed: 2 }),
    });
    expect(orbit.requests).toHaveLength(1);
  });

  it.each([
    [403, "node_access.required"],
    [409, "instance.default_protected"],
    [409, "instance.not_container"],
    [409, "instance.lifecycle_busy"],
    [409, "instance.database_attached_elsewhere"],
    [409, "operation.target_busy"],
    [409, "operation.idempotency_conflict"],
  ])("reports a %i %s refusal as a failure with Orbit's words", async (status, code) => {
    const orbit = gateway([error(status, code)]);
    expect(await orbit.remove(true)).toEqual({
      kind: "failed",
      code,
      message: `Orbit says ${code}.`,
    });
    expect(orbit.requests).toHaveLength(1);
  });

  it("repeats a lost destroy request under the same key, and rides out a short outage", async () => {
    const orbit = gateway([
      new Error("socket hang up"),
      ok(op("running"), 202),
      new Error("socket hang up"),
      ok(op("succeeded")),
    ]);
    expect(await orbit.remove(true)).toEqual({ kind: "removed" });
    expect(orbit.requests.map((request) => request.idempotencyKey ?? null)).toEqual([
      "key-1",
      "key-1",
      null,
      null,
    ]);
  });

  it("shows a failed or never-ending destroy as failed, with the Operation's code", async () => {
    const failing = gateway([
      ok(op("running"), 202),
      ok(
        op("failed", {
          error: { code: "swamp.destroy_failed", message: "Swamp lost the Node.", detail: null },
        }),
      ),
    ]);
    expect(await failing.remove(true)).toEqual({
      kind: "failed",
      code: "swamp.destroy_failed",
      message: "Swamp lost the Node.",
    });

    const silent = gateway([ok(op("running"), 202), ok(op("cancelled"))]);
    expect(await silent.remove(true)).toEqual({
      kind: "failed",
      code: "operation.cancelled",
      message: "Orbit did not finish removing the Instance.",
    });

    const stuck = gateway([
      ok(op("running"), 202),
      ...Array.from({ length: 400 }, () => ok(op("running"))),
    ]);
    expect(await stuck.remove(true)).toMatchObject({ kind: "failed", code: "operation.timeout" });
    expect(stuck.elapsed()).toBe(DESTROY_TIMEOUT_MS);
  });

  it("stops polling on an interrupted Operation", async () => {
    const orbit = gateway([
      ok(op("running"), 202),
      ok(op("interrupted", { error: { code: null, message: null, detail: null } })),
    ]);
    expect(await orbit.remove(true)).toEqual({
      kind: "failed",
      code: "operation.interrupted",
      message: "Orbit did not finish removing the Instance.",
    });
    expect(orbit.requests).toHaveLength(2);
  });

  it("refuses an Operation that is not a destroy", async () => {
    const orbit = gateway([ok(op("queued", { kind: "instance.create" }), 202)]);
    expect(await orbit.remove(true)).toMatchObject({
      kind: "failed",
      code: "gateway.response_invalid",
    });
  });
});

describe("orbitInstanceRemoveText", () => {
  const target = (extra: Partial<OrbitInstanceRemoveTarget>): OrbitInstanceRemoveTarget => ({
    name: "pricing-page",
    domain: "pricing-page.nckrtl.test",
    nodeName: "beast",
    threadCount: 2,
    workingCount: 0,
    git: parseOrbitInstanceGit({
      state: "known",
      branch: "pricing-page",
      uncommitted: 0,
      unpushed: 0,
    }),
    ...extra,
  });
  const known = (uncommitted: number, unpushed: number) =>
    parseOrbitInstanceGit({ state: "known", branch: "pricing-page", uncommitted, unpushed });

  it("asks once for a clean Instance, with the thread count in words", () => {
    const text = orbitInstanceRemoveText(target({}));
    expect(`${text.before}${text.target}${text.after}`).toBe(
      "Orbit removes the Instance pricing-page.nckrtl.test on beast and its container. The 2 threads in it are removed from Conn. You cannot undo this.",
    );
    expect(text).toMatchObject({ title: "Remove pricing-page?", warning: null, acknowledge: null });
    expect(orbitInstanceRemoveText(target({ threadCount: 1 })).after).toContain(
      "The thread in it is removed from Conn.",
    );
    expect(orbitInstanceRemoveText(target({ threadCount: 0 })).after).toContain(
      "It has no threads.",
    );
  });

  it("lists the work that is lost and asks for the tick", () => {
    expect(orbitInstanceRemoveText(target({ git: known(3, 2) }))).toMatchObject({
      warning: {
        kind: "lost",
        heading: "This Instance holds work that is not on the remote:",
        items: ["3 uncommitted changes", "2 commits not pushed on branch pricing-page"],
      },
      acknowledge: "Remove it anyway. This work is lost.",
    });
    expect(orbitInstanceRemoveText(target({ workingCount: 1 }))).toMatchObject({
      warning: {
        heading: "This Instance is in use:",
        items: ["1 thread is working now. It stops."],
      },
      acknowledge: "Remove it anyway. The thread stops.",
    });
    for (const git of [{ state: "unknown", reason: "stopped" } as const, undefined]) {
      expect(orbitInstanceRemoveText(target({ git }))).toMatchObject({
        warning: {
          kind: "unknown",
          text: "Orbit cannot tell whether this Instance holds work that is not on the remote.",
        },
        acknowledge: "Remove it anyway. Any unsaved work is lost.",
      });
    }
  });
});
