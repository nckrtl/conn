import { describe, expect, it } from "vite-plus/test";

import type { OrbitGatewayOperation, OrbitGatewayOperationStep } from "./client.ts";
import {
  observeOrbitCreateRows,
  orbitCreateRowOf,
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
