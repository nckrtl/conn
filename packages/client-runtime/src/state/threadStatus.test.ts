import { describe, expect, it } from "vite-plus/test";

import { hasUnseenCompletion, resolveThreadStatus } from "./threadStatus.ts";

const idle = { hasPendingApprovals: false, hasPendingUserInput: false, session: null };

describe("resolveThreadStatus", () => {
  it("reports monitoring when watch loops are the only live work", () => {
    expect(resolveThreadStatus({ ...idle, backgroundLiveness: "monitoring" })).toBe("monitoring");
  });

  it("reports working for background fleets after the turn settled", () => {
    expect(resolveThreadStatus({ ...idle, backgroundLiveness: "working" })).toBe("working");
  });

  it("ignores absent and null liveness from old servers", () => {
    expect(resolveThreadStatus(idle)).toBe("ready");
    expect(resolveThreadStatus({ ...idle, backgroundLiveness: null })).toBe("ready");
  });

  it("lets a live session outrank monitoring", () => {
    expect(
      resolveThreadStatus({
        ...idle,
        session: { status: "running" },
        backgroundLiveness: "monitoring",
      }),
    ).toBe("working");
    expect(
      resolveThreadStatus({
        ...idle,
        session: { status: "starting" },
        backgroundLiveness: "monitoring",
      }),
    ).toBe("working");
  });

  it("shows a failed session rather than lingering background liveness", () => {
    for (const backgroundLiveness of ["working", "monitoring"] as const) {
      expect(
        resolveThreadStatus({ ...idle, session: { status: "error" }, backgroundLiveness }),
      ).toBe("failed");
    }
  });

  it("puts approval, then input, above everything else", () => {
    const busy = { session: { status: "running" }, backgroundLiveness: "monitoring" } as const;
    expect(resolveThreadStatus({ ...idle, ...busy, hasPendingUserInput: true })).toBe("input");
    expect(
      resolveThreadStatus({
        ...idle,
        ...busy,
        hasPendingApprovals: true,
        hasPendingUserInput: true,
      }),
    ).toBe("approval");
  });

  it("reads a stopped session as ready", () => {
    expect(resolveThreadStatus({ ...idle, session: { status: "stopped" } })).toBe("ready");
  });
});

describe("hasUnseenCompletion", () => {
  const latestTurn = { completedAt: "2026-03-09T10:05:00.000Z" };

  it("is true when the turn completed after the last visit", () => {
    expect(hasUnseenCompletion({ latestTurn, lastVisitedAt: "2026-03-09T10:04:00.000Z" })).toBe(
      true,
    );
  });

  it("clears once the visit is stamped at or after the completion", () => {
    expect(hasUnseenCompletion({ latestTurn, lastVisitedAt: latestTurn.completedAt })).toBe(false);
    expect(hasUnseenCompletion({ latestTurn, lastVisitedAt: "2026-03-09T10:06:00.000Z" })).toBe(
      false,
    );
  });

  it("treats a thread this client never visited as read", () => {
    expect(hasUnseenCompletion({ latestTurn })).toBe(false);
  });

  it("is false while the turn has not completed", () => {
    expect(
      hasUnseenCompletion({
        latestTurn: { completedAt: null },
        lastVisitedAt: "2026-03-09T10:04:00.000Z",
      }),
    ).toBe(false);
    expect(
      hasUnseenCompletion({ latestTurn: null, lastVisitedAt: "2026-03-09T10:04:00.000Z" }),
    ).toBe(false);
  });

  it("treats an unparseable visit stamp as unread", () => {
    expect(hasUnseenCompletion({ latestTurn, lastVisitedAt: "not-a-date" })).toBe(true);
  });
});
