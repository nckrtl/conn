import { describe, expect, it, vi } from "vite-plus/test";

vi.mock("expo-file-system", () => ({ File: vi.fn(), Paths: {} }));
vi.mock("../lib/atomic-file", () => ({ writeFileAtomically: vi.fn() }));
vi.mock("../state/atom-registry", () => ({ appAtomRegistry: {} }));
vi.mock("../state/shell", () => ({ environmentShell: {}, shellCachesReadAtom: {} }));
vi.mock("./catalog", () => ({ environmentCatalog: {} }));

import { launchTimingRecord, launchTimingSettled, type LaunchShellPhase } from "./launchTiming";

const sample = (at: number, cachesRead: boolean, phases: Record<string, LaunchShellPhase>) => ({
  at,
  cachesRead,
  shells: new Map(Object.entries(phases)),
});

describe("launchTimingRecord", () => {
  it("records the cache read, the first live server and the moment all settled", () => {
    const record = launchTimingRecord(new Date("2026-11-14T12:00:00Z"), [
      sample(100, false, { a: "waiting", b: "waiting" }),
      sample(300, true, { a: "waiting", b: "waiting" }),
      sample(900, true, { a: "live", b: "waiting" }),
      sample(4000, true, { a: "live", b: "failed" }),
    ]);
    expect(record).toEqual({
      startedAt: "2026-11-14T12:00:00.000Z",
      enabledEnvironments: 2,
      cachesReadMs: 300,
      firstLiveMs: 900,
      allSettledMs: 4000,
      live: 1,
      failed: 1,
      waiting: 0,
    });
  });

  it("leaves allSettled empty when a server still connects at the limit", () => {
    const record = launchTimingRecord(new Date(0), [
      sample(60_000, true, { a: "live", b: "waiting" }),
    ]);
    expect(record.allSettledMs).toBeNull();
    expect(record.waiting).toBe(1);
  });
});

describe("launchTimingSettled", () => {
  it("needs the caches read and no server still connecting", () => {
    expect(launchTimingSettled(sample(1, false, { a: "live" }))).toBe(false);
    expect(launchTimingSettled(sample(1, true, { a: "waiting" }))).toBe(false);
    expect(launchTimingSettled(sample(1, true, {}))).toBe(false);
    expect(launchTimingSettled(sample(1, true, { a: "live", b: "failed" }))).toBe(true);
  });
});
