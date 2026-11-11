import type { OrbitGatewayProjectCheck } from "@t3tools/client-runtime/orbit-gateway";
import { describe, expect, it, vi } from "vite-plus/test";

import {
  checkOrbitProjectAgain,
  forgetOrbitRecheckFailure,
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

const rowsOf = (
  checks: ReadonlyArray<OrbitGatewayProjectCheck> | null,
  reason = "Orbit says no.",
) => orbitChecksPageModel({ startable: false, reason, checks });

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

  it("shows the five as not checked yet without checks, with the reason alone", () => {
    const model = rowsOf(null);
    expect(model.rows.every((row) => row.status === "not_checked")).toBe(true);
    expect(model.reason).toBe("Orbit says no.");
  });

  it("shows cloneable_reason alone when no check fails", () => {
    expect(rowsOf(liveChecks(null)).reason).toBe("Orbit says no.");
    expect(orbitChecksPageModel({ startable: false, reason: null, checks: null }).reason).toBe(
      "Orbit did not say why threads cannot start here yet.",
    );
    expect(
      orbitChecksPageModel({ startable: true, reason: null, checks: liveChecks(null) }).reason,
    ).toBeNull();
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
    forgetOrbitRecheckFailure(5);
    expect(readOrbitRecheckPhase(5)).toBe("idle");
  });

  it("offers the Instance step once a re-read finds the Project startable", () => {
    expect(rowsOf(liveChecks("container")).startable).toBe(false);
    const after = orbitChecksPageModel({ startable: true, reason: null, checks: liveChecks(null) });
    expect(after.startable).toBe(true);
    expect(after.rows.every((row) => row.status === "pass")).toBe(true);
  });
});
