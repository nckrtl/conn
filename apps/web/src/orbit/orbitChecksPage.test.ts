import type { OrbitGatewayProjectCheck } from "@t3tools/client-runtime/orbit-gateway";
import { describe, expect, it, vi } from "vite-plus/test";

import {
  checkOrbitProjectAgain,
  forgetOrbitRecheck,
  orbitChecksPageModel,
  readOrbitRecheckPhase,
} from "./orbitChecksPage";

const TECHNICAL_KEYS = [
  "source_access",
  "source_defaults",
  "production_placement",
  "node_active_linux",
  "app_dev_role",
  "source_profile",
  "php_readiness",
  "runtime_contributions",
  "model_route",
  "native_create",
];

/** The Gateway's answer: all checks in order, pass up to `failKey`, then not_checked. */
function liveChecks(failKey: string | null, extra: ReadonlyArray<string> = []) {
  const keys = [
    "default_instance",
    "container",
    "active",
    "seed_snapshot",
    "node_access",
    ...TECHNICAL_KEYS,
    ...extra,
  ];
  const failIndex = failKey === null ? -1 : keys.indexOf(failKey);
  return keys.map((key, index): OrbitGatewayProjectCheck => {
    if (index === failIndex) {
      return {
        key,
        label: `Orbit ${key}`,
        status: "fail",
        code: "instance.default_missing",
        message: `Fix ${key} in Orbit.`,
      };
    }
    const status = failIndex !== -1 && index > failIndex ? "not_checked" : "pass";
    return { key, label: `Orbit ${key}`, status, code: null, message: null };
  });
}

const rowsOf = (checks: ReadonlyArray<OrbitGatewayProjectCheck> | null) =>
  orbitChecksPageModel({ startable: false, checks });
const UNEXPLAINED = "Orbit did not say why threads cannot start here yet.";

describe("orbitChecksPageModel", () => {
  it("shows the five checks in order with Conn's text and stops at the first fail", () => {
    const model = rowsOf(liveChecks("container"));
    expect(model.rows).toEqual([
      { key: "default_instance", label: "Default Instance", status: "pass", message: null },
      {
        key: "container",
        label: "Runs in a container",
        status: "fail",
        message: "Fix container in Orbit.",
      },
      { key: "active", label: "Active", status: "not_checked", message: null },
      { key: "seed_snapshot", label: "Seed snapshot", status: "not_checked", message: null },
      { key: "node_access", label: "Node access", status: "not_checked", message: null },
    ]);
    expect(model.reason).toBeNull();
  });

  it("treats a check after the first fail as not checked, even when the Gateway sent another fail", () => {
    const checks = liveChecks("default_instance").map((check) =>
      check.key === "active" ? { ...check, status: "fail" as const, message: "Later." } : check,
    );
    expect(rowsOf(checks).rows.map((row) => row.status)).toEqual([
      "fail",
      "not_checked",
      "not_checked",
      "not_checked",
      "not_checked",
    ]);
  });

  it("adds one row for a failing technical or unknown key, labelled by the server", () => {
    const technical = rowsOf(liveChecks("source_access"));
    expect(technical.rows).toHaveLength(6);
    expect(technical.rows.slice(0, 5).every((row) => row.status === "pass")).toBe(true);
    expect(technical.rows[5]).toEqual({
      key: "source_access",
      label: "Orbit source_access",
      status: "fail",
      message: "Fix source_access in Orbit.",
    });

    const unknown = liveChecks("future_check", ["future_check"]).map((check) =>
      check.key === "future_check" ? { ...check, label: null } : check,
    );
    expect(rowsOf(unknown).rows[5]).toMatchObject({
      label: "Other requirement",
      message: "Fix future_check in Orbit.",
    });
  });

  it("ignores passing and not-checked technical or unknown keys", () => {
    const model = rowsOf(liveChecks("container", ["future_check"]));
    expect(model.rows.map((row) => row.key)).toEqual([
      "default_instance",
      "container",
      "active",
      "seed_snapshot",
      "node_access",
    ]);
  });

  it("shows the five as not checked yet without checks, and says Orbit gave no reason", () => {
    const model = rowsOf(null);
    expect(model.rows.every((row) => row.status === "not_checked")).toBe(true);
    expect(model.reason).toBe(UNEXPLAINED);
  });

  it("says Orbit gave no reason when threads cannot start and no check fails", () => {
    expect(rowsOf(liveChecks(null)).reason).toBe(UNEXPLAINED);
    expect(orbitChecksPageModel({ startable: true, checks: liveChecks(null) }).reason).toBeNull();
  });
});

describe("checkOrbitProjectAgain", () => {
  it("is busy while it reads, idle when the Gateway answers, failed when it does not", async () => {
    let answer: (value: boolean) => void = () => {};
    const reread = vi.fn(() => new Promise<boolean>((resolve) => (answer = resolve)));
    const running = checkOrbitProjectAgain(5, reread);
    expect(readOrbitRecheckPhase(5)).toBe("checking");
    expect(readOrbitRecheckPhase(6)).toBe("idle");
    await checkOrbitProjectAgain(5, reread);
    expect(reread).toHaveBeenCalledOnce();
    answer(true);
    await running;
    expect(readOrbitRecheckPhase(5)).toBe("idle");

    await checkOrbitProjectAgain(5, async () => false);
    expect(readOrbitRecheckPhase(5)).toBe("failed");
    await checkOrbitProjectAgain(5, () => Promise.reject(new Error("offline")));
    expect(readOrbitRecheckPhase(5)).toBe("failed");
    forgetOrbitRecheck(5);
    expect(readOrbitRecheckPhase(5)).toBe("idle");

    // An answer that arrives after the page closed leaves no note behind.
    const late = checkOrbitProjectAgain(5, reread);
    forgetOrbitRecheck(5);
    answer(false);
    await late;
    expect(readOrbitRecheckPhase(5)).toBe("idle");

    // Back on the page with a new check: the older read's answer does not end it.
    let older: (value: boolean) => void = () => {};
    const first = checkOrbitProjectAgain(5, () => new Promise<boolean>((done) => (older = done)));
    forgetOrbitRecheck(5);
    const second = checkOrbitProjectAgain(5, reread);
    older(false);
    await first;
    expect(readOrbitRecheckPhase(5)).toBe("checking");
    answer(true);
    await second;
    expect(readOrbitRecheckPhase(5)).toBe("idle");
  });
});
