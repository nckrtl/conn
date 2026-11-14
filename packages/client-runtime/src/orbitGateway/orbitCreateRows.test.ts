import { describe, expect, it } from "vite-plus/test";

import type { OrbitGatewayOperation, OrbitGatewayOperationStep } from "./client.ts";
import {
  observeOrbitCompletionRows,
  observeOrbitCreateRows,
  orbitCompletionFailedRow,
  orbitCompletionRowOf,
  orbitCreateRowOf,
  reopenOrbitCompletionRows,
  readSavedOrbitCreateRows,
  type OrbitCreateRows,
} from "./orbitCreateRows.ts";

function step(
  name: string,
  status: string,
  extra: Partial<OrbitGatewayOperationStep> = {},
): OrbitGatewayOperationStep {
  return { name, job: null, status, startedAt: null, finishedAt: null, ...extra };
}

function op(
  status: OrbitGatewayOperation["status"],
  steps: readonly OrbitGatewayOperationStep[],
  extra: Partial<OrbitGatewayOperation> = {},
): OrbitGatewayOperation {
  return {
    id: 100,
    kind: "instance.create",
    status,
    targetId: 41,
    errorCode: null,
    pollAfterSeconds: 2,
    steps,
    ...extra,
  };
}

/** Each row that has a state, as `id:status`. */
function statuses(rows: OrbitCreateRows): string[] {
  return Object.entries(rows).map(([id, row]) => `${id}:${row!.status}`);
}

describe("orbitCreateRowOf", () => {
  it.each([
    ["input", "container"],
    ["clone-input", "container"],
    ["clone-container", "container"],
    ["clone-route-csr-1", "address"],
    ["csr", "address"],
    ["sign", "address"],
    ["clone-route", "address"],
    ["site", "address"],
    ["records-2", "address"],
    ["catalog-1", "address"],
    ["restart-caddy", "address"],
    ["Install cert, publish the route", "address"],
    ["Publish private DNS for meetup", "address"],
    ["Probe the site over TLS", "address"],
    ["clone-workspace", "workspace"],
    ["clone-agent", "t3"],
    ["clone-t3", "t3"],
    ["clone-sessions", "register"],
    ["clone-session-copy", "register"],
    ["clone-register", "register"],
    ["finish", "register"],
    ["clone-private-cleanup", "register"],
    ["cleanup", "register"],
    ["accepted", "register"],
    ["clone-something-new", null],
    ["constructor", null],
  ])("puts %s in %s", (name, row) => {
    expect(orbitCreateRowOf({ name })).toBe(row);
  });

  it("prefers Orbit's group, and falls back to the name for a group it does not know", () => {
    expect(orbitCreateRowOf({ name: "clone-container", group: "t3" })).toBe("t3");
    expect(orbitCreateRowOf({ name: "brand-new", group: "workspace" })).toBe("workspace");
    expect(orbitCreateRowOf({ name: "clone-t3", group: "later" })).toBe("t3");
  });
});

describe("observeOrbitCreateRows", () => {
  it("runs the container copy and the address side by side", () => {
    const rows = observeOrbitCreateRows(
      null,
      op("running", [
        step("input", "succeeded"),
        step("clone-container", "running"),
        step("csr", "succeeded"),
        step("sign", "running"),
        step("clone-workspace", "pending"),
      ]),
      1_000,
    );
    expect(statuses(rows)).toEqual(["container:running", "address:running"]);
    expect(rows.container).toEqual({ status: "running", startedAt: 1_000, finishedAt: null });
  });

  it("counts skipped steps as nothing", () => {
    const rows = observeOrbitCreateRows(
      null,
      op("running", [step("clone-input", "skipped"), step("csr", "running")]),
      1_000,
    );
    expect(statuses(rows)).toEqual(["address:running"]);
  });

  it("keeps an unknown running step with the row that ran, never blanking the card", () => {
    const before = observeOrbitCreateRows(
      null,
      op("running", [step("clone-workspace", "running")]),
      1_000,
    );
    const rows = observeOrbitCreateRows(
      before,
      op("running", [step("clone-workspace", "succeeded"), step("clone-mystery", "running")]),
      2_000,
    );
    expect(rows.workspace).toEqual({ status: "running", startedAt: 1_000, finishedAt: null });
    expect(rows.t3).toBeUndefined();
  });

  it("follows current_step alone, marking earlier phases done", () => {
    const rows = observeOrbitCreateRows(
      null,
      op("running", [], { currentStep: "clone-t3" }),
      5_000,
    );
    expect(statuses(rows)).toEqual([
      "container:done",
      "address:done",
      "workspace:done",
      "t3:running",
    ]);
  });

  it("turns the row of the failed step red", () => {
    const rows = observeOrbitCreateRows(
      null,
      op("failed", [], { failedStep: "clone-sessions", errorCode: "instance.t3_unready" }),
      9_000,
    );
    expect(rows.register).toEqual({ status: "failed", startedAt: 9_000, finishedAt: 9_000 });
    const listed = observeOrbitCreateRows(
      null,
      op("failed", [step("clone-container", "succeeded"), step("clone-workspace", "failed")]),
      9_000,
    );
    expect(statuses(listed)).toEqual(["container:done", "workspace:failed"]);
  });

  it("puts an unknown failed step on the row that ran", () => {
    const before = observeOrbitCreateRows(null, op("running", [step("clone-t3", "running")]), 1);
    const rows = observeOrbitCreateRows(
      before,
      op("failed", [], { failedStep: "clone-mystery" }),
      2,
    );
    expect(rows.t3?.status).toBe("failed");
  });

  it("times rows from when Conn first saw them, then takes Orbit's times once the create ended", () => {
    let rows = observeOrbitCreateRows(
      null,
      op("running", [step("clone-container", "running")]),
      1_000,
    );
    rows = observeOrbitCreateRows(
      rows,
      op("running", [step("clone-container", "succeeded"), step("clone-workspace", "running")]),
      4_000,
    );
    expect(rows.container).toEqual({ status: "done", startedAt: 1_000, finishedAt: 4_000 });
    expect(rows.workspace).toEqual({ status: "running", startedAt: 4_000, finishedAt: null });
    // Orbit sends its times only on the ended Operation.
    const at = (s: number) => `1970-01-01T00:00:0${s}.000Z`;
    rows = observeOrbitCreateRows(
      rows,
      op("succeeded", [
        step("input", "succeeded", { startedAt: at(1), finishedAt: at(2) }),
        step("clone-container", "succeeded", { startedAt: at(2), finishedAt: at(3) }),
        step("clone-workspace", "succeeded", { startedAt: at(3), finishedAt: at(7) }),
      ]),
      8_000,
    );
    expect(rows.container).toEqual({ status: "done", startedAt: 1_000, finishedAt: 3_000 });
    expect(rows.workspace).toEqual({ status: "done", startedAt: 3_000, finishedAt: 7_000 });
    expect(rows.register).toEqual({ status: "done", startedAt: 8_000, finishedAt: 8_000 });
  });

  it("never moves a row back to pending", () => {
    const before = observeOrbitCreateRows(null, op("running", [step("site", "running")]), 1);
    expect(observeOrbitCreateRows(before, op("running", []), 2)).toEqual(before);
  });
});

describe("readSavedOrbitCreateRows", () => {
  it("reads saved rows and drops broken ones", () => {
    expect(
      readSavedOrbitCreateRows({
        container: { status: "done", startedAt: 1, finishedAt: 2 },
        address: { status: "weird" },
        t3: { status: "running", startedAt: "x" },
      }),
    ).toEqual({
      container: { status: "done", startedAt: 1, finishedAt: 2 },
      t3: { status: "running", startedAt: null, finishedAt: null },
    });
    expect(readSavedOrbitCreateRows(undefined)).toBe(null);
  });
});

const T = (seconds: number) => `2026-11-14T01:11:${String(seconds).padStart(2, "0")}.000Z`;
const ms = (seconds: number) => Date.parse(T(seconds));

/** Create 20511 (release 2030) as Conn reads it at its success, trimmed to the row steps. */
function createAtSuccess(extra: Partial<OrbitGatewayOperation> = {}): OrbitGatewayOperation {
  return op(
    "succeeded",
    [
      step("input", "succeeded", { job: "input", startedAt: T(21), finishedAt: T(22) }),
      step("clone-input", "succeeded", { job: "clone", startedAt: T(22), finishedAt: T(24) }),
      step("clone-container", "succeeded", { job: "clone", startedAt: T(24), finishedAt: T(31) }),
      step("clone-t3", "succeeded", { job: "clone", startedAt: T(31), finishedAt: T(36) }),
      step("clone-workspace", "succeeded", { job: "clone", startedAt: T(31), finishedAt: T(32) }),
      step("clone-register", "succeeded", { job: "clone", startedAt: T(40), finishedAt: T(41) }),
      step("finish", "succeeded", { job: "create", startedAt: T(41), finishedAt: T(42) }),
    ],
    { completionOperationId: 20512, routeId: 77, ...extra },
  );
}

function completion(
  status: OrbitGatewayOperation["status"],
  steps: readonly OrbitGatewayOperationStep[],
  extra: Partial<OrbitGatewayOperation> = {},
): OrbitGatewayOperation {
  return op(status, steps, { id: 20512, kind: "instance.complete", ...extra });
}

describe("create success with a completion (release 2030)", () => {
  it("leaves the workspace and the address running, the other three done", () => {
    const rows = observeOrbitCreateRows(null, createAtSuccess(), ms(43));
    expect(statuses(rows)).toEqual([
      "container:done",
      "address:running",
      "workspace:running",
      "t3:done",
      "register:done",
    ]);
    // The workspace keeps the start of the create's checkout and has no end yet.
    expect(rows.workspace).toEqual({ status: "running", startedAt: ms(31), finishedAt: null });
    expect(rows.address?.finishedAt).toBeNull();
  });

  it("marks the address done when the Project has no Route", () => {
    const rows = observeOrbitCreateRows(null, createAtSuccess({ routeId: null }), ms(43));
    expect(rows.address?.status).toBe("done");
    expect(rows.workspace?.status).toBe("running");
  });

  it("marks all five done on an older Gateway that names no completion", () => {
    const { completionOperationId: _id, routeId: _route, ...older } = createAtSuccess();
    const rows = observeOrbitCreateRows(null, older, ms(43));
    expect(statuses(rows)).toEqual([
      "container:done",
      "address:done",
      "workspace:done",
      "t3:done",
      "register:done",
    ]);
  });

  it("maps clone-club-key to the container row", () => {
    expect(orbitCreateRowOf({ name: "clone-club-key" })).toBe("container");
  });
});

describe("orbitCompletionRowOf", () => {
  it.each([
    ["input", "input", null],
    ["clone-input", "complete", "workspace"],
    ["database-snapshot", "complete", "workspace"],
    ["server-database", "complete", "workspace"],
    ["server-valkey", "complete", "workspace"],
    ["database-install", "complete", "workspace"],
    ["server-database-check", "complete", "workspace"],
    ["server-valkey-check", "complete", "workspace"],
    ["clone-fleet", "complete", "workspace"],
    ["database-cleanup", "complete", "workspace"],
    ["server-database-fill", "complete", "workspace"],
    ["clone-services", "complete", "workspace"],
    ["clone-check", "complete", "workspace"],
    ["route-csr-0", "publication", "address"],
    ["route-csr-0-0", "publication", "address"],
    ["route", "publication", "address"],
    // Child workflow steps reuse names that the create maps; under a child job they show nothing.
    ["input", "create", null],
    ["cleanup", "create", null],
    ["site", "create", null],
    ["csr", "create", null],
    ["sign", "create", null],
    ["Make a CSR on the Node-0", "create", null],
    ["Install cert, publish site-9-0", "create", null],
    ["Probe the site over TLS-0-0", "create", null],
    ["Publish private DNS-0-0", "create", null],
    ["records-0-0", "create", null],
    ["withdraw_route-0", "withdraw", null],
    ["finish", "result", null],
    ["clone-private-cleanup", "result", null],
    ["withdraw-route", "result", null],
    ["cleanup", "result", null],
    ["accepted", "result", null],
    ["something-new", "other", null],
  ] as const)("%s in job %s → %s", (name, job, row) => {
    expect(orbitCompletionRowOf({ name, job })).toBe(row);
  });
});

describe("observeOrbitCompletionRows", () => {
  const atCreate = () => observeOrbitCreateRows(null, createAtSuccess(), ms(43));

  it("keeps the other rows and infers no order while the workspace runs", () => {
    const rows = observeOrbitCompletionRows(
      atCreate(),
      completion("running", [
        step("input", "succeeded", { job: "input", startedAt: T(47), finishedAt: T(48) }),
        step("clone-input", "succeeded", { job: "complete", startedAt: T(48), finishedAt: T(49) }),
        step("clone-services", "running", { job: "complete", startedAt: T(49) }),
        step("csr", "running", { job: "create", startedAt: T(48) }),
        step("brand-new-step", "failed", { job: "mystery" }),
      ]),
      ms(50),
    );
    expect(statuses(rows)).toEqual([
      "container:done",
      "address:running",
      "workspace:running",
      "t3:done",
      "register:done",
    ]);
    expect(rows.workspace).toEqual({ status: "running", startedAt: ms(31), finishedAt: null });
  });

  it("marks both rows done with the last step's end when the completion succeeded (20512)", () => {
    const rows = observeOrbitCompletionRows(
      atCreate(),
      completion(
        "succeeded",
        [
          step("clone-input", "succeeded", {
            job: "complete",
            startedAt: T(48),
            finishedAt: T(49),
          }),
          step("route-csr-0-0", "succeeded", {
            job: "publication",
            startedAt: T(48),
            finishedAt: T(51),
          }),
          step("clone-services", "succeeded", {
            job: "complete",
            startedAt: T(49),
            finishedAt: T(53),
          }),
          step("route", "succeeded", { job: "publication", startedAt: T(51), finishedAt: T(57) }),
          step("clone-check", "succeeded", {
            job: "complete",
            startedAt: T(53),
            finishedAt: T(54),
          }),
          step("finish", "succeeded", { job: "result", startedAt: T(57), finishedAt: T(58) }),
        ],
        { pollAfterSeconds: null },
      ),
      ms(59),
    );
    expect(rows.workspace).toEqual({ status: "done", startedAt: ms(31), finishedAt: ms(54) });
    expect(rows.address?.status).toBe("done");
    expect(rows.address?.finishedAt).toBe(ms(57));
  });

  it.each([
    ["database", "workspace"],
    ["fleet", "workspace"],
    ["workspace", "workspace"],
    ["check", "workspace"],
    ["complete", "workspace"],
    ["route", "address"],
  ] as const)("fails the row of phase %s → %s", (phase, row) => {
    const failed = completion("failed", [], { resultFailedStep: phase, pollAfterSeconds: null });
    expect(orbitCompletionFailedRow(failed)).toBe(row);
    const rows = observeOrbitCompletionRows(atCreate(), failed, ms(60));
    expect(rows[row]?.status).toBe("failed");
    expect(rows.t3?.status).toBe("done");
  });

  it("without a phase, fails the row of a failed step, else the workspace", () => {
    expect(
      orbitCompletionFailedRow(
        completion("failed", [step("route-csr-1", "failed", { job: "publication" })]),
      ),
    ).toBe("address");
    expect(orbitCompletionFailedRow(completion("cancelled", []))).toBe("workspace");
  });

  it("marks the workspace done and the address failed when publication failed", () => {
    const rows = observeOrbitCompletionRows(
      atCreate(),
      completion(
        "failed",
        [
          step("clone-input", "succeeded", {
            job: "complete",
            startedAt: T(48),
            finishedAt: T(49),
          }),
          step("clone-check", "succeeded", {
            job: "complete",
            startedAt: T(53),
            finishedAt: T(54),
          }),
          step("route", "failed", { job: "publication", startedAt: T(51), finishedAt: T(56) }),
        ],
        { resultFailedStep: "route", pollAfterSeconds: null },
      ),
      ms(57),
    );
    expect(rows.workspace?.status).toBe("done");
    expect(rows.address).toEqual({ status: "failed", startedAt: ms(43), finishedAt: ms(56) });
  });

  it("puts a row that never ran back to pending when the completion failed elsewhere", () => {
    const rows = observeOrbitCompletionRows(
      atCreate(),
      completion(
        "failed",
        [
          step("clone-services", "failed", {
            job: "complete",
            startedAt: T(49),
            finishedAt: T(50),
          }),
        ],
        { resultFailedStep: "workspace", pollAfterSeconds: null },
      ),
      ms(51),
    );
    expect(rows.workspace?.status).toBe("failed");
    expect(rows.address).toEqual({ status: "pending", startedAt: ms(43), finishedAt: null });
  });

  it("a Retry runs only the failed row again, and a done row stays done", () => {
    const failed = observeOrbitCompletionRows(
      atCreate(),
      completion(
        "failed",
        [
          step("clone-check", "succeeded", { job: "complete", finishedAt: T(54) }),
          step("route", "failed", { job: "publication", finishedAt: T(56) }),
        ],
        { resultFailedStep: "route" },
      ),
      ms(57),
    );
    const reopened = reopenOrbitCompletionRows(failed)!;
    expect(reopened.address).toEqual({ status: "running", startedAt: ms(43), finishedAt: null });
    expect(reopened.workspace?.status).toBe("done");
    const running = observeOrbitCompletionRows(reopened, completion("queued", []), ms(60));
    expect(running.workspace?.status).toBe("done");
    expect(running.address?.status).toBe("running");
  });
});
