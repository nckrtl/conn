import { enabledEnvironmentIds } from "@t3tools/client-runtime/state/connections";
import type { EnvironmentId } from "@t3tools/contracts";
import { File, Paths } from "expo-file-system";
import * as Option from "effect/Option";

import { writeFileAtomically } from "../lib/atomic-file";
import { appAtomRegistry } from "../state/atom-registry";
import { environmentShell, shellCachesReadAtom } from "../state/shell";
import { environmentCatalog } from "./catalog";

/**
 * Conn: one line per app launch in `conn-launch-timing.ndjson` (app documents), read from the
 * device with `devicectl`. It measures how long the thread list takes to become usable and how
 * many servers the launch connects, so a change to what the phone connects can be compared with
 * today. It shows nothing on screen and sends nothing anywhere.
 */

const TIMING_FILE = "conn-launch-timing.ndjson";
const KEEP_LINES = 50;
/** A launch that has not settled by then is written as it stands. */
const SETTLE_LIMIT_MS = 60_000;

export type LaunchShellPhase = "waiting" | "live" | "failed";

export interface LaunchTimingSample {
  /** Milliseconds since the launch began. */
  readonly at: number;
  readonly cachesRead: boolean;
  /** Each enabled environment's shell: still connecting, live, or failed. */
  readonly shells: ReadonlyMap<string, LaunchShellPhase>;
}

export interface LaunchTimingRecord {
  readonly startedAt: string;
  readonly enabledEnvironments: number;
  readonly cachesReadMs: number | null;
  readonly firstLiveMs: number | null;
  /** Every enabled environment live or failed; null when the launch hit the limit first. */
  readonly allSettledMs: number | null;
  readonly live: number;
  readonly failed: number;
  readonly waiting: number;
}

/** Folds launch samples into the record a launch writes. Pure, for tests. */
export function launchTimingRecord(
  startedAt: Date,
  samples: readonly LaunchTimingSample[],
): LaunchTimingRecord {
  let cachesReadMs: number | null = null;
  let firstLiveMs: number | null = null;
  let allSettledMs: number | null = null;
  let last: LaunchTimingSample | undefined;
  for (const sample of samples) {
    last = sample;
    const phases = [...sample.shells.values()];
    if (cachesReadMs === null && sample.cachesRead) cachesReadMs = sample.at;
    if (firstLiveMs === null && phases.includes("live")) firstLiveMs = sample.at;
    if (
      allSettledMs === null &&
      sample.cachesRead &&
      phases.length > 0 &&
      !phases.includes("waiting")
    ) {
      allSettledMs = sample.at;
    }
  }
  const phases = [...(last?.shells.values() ?? [])];
  const count = (phase: LaunchShellPhase) => phases.filter((entry) => entry === phase).length;
  return {
    startedAt: startedAt.toISOString(),
    enabledEnvironments: phases.length,
    cachesReadMs,
    firstLiveMs,
    allSettledMs,
    live: count("live"),
    failed: count("failed"),
    waiting: count("waiting"),
  };
}

/** True once the samples need no more: every enabled environment live or failed. */
export function launchTimingSettled(sample: LaunchTimingSample): boolean {
  const phases = [...sample.shells.values()];
  return sample.cachesRead && phases.length > 0 && !phases.includes("waiting");
}

function sampleNow(startedMs: number): LaunchTimingSample {
  const catalog = appAtomRegistry.get(environmentCatalog.catalogValueAtom);
  const shells = new Map<string, LaunchShellPhase>();
  if (catalog.isReady) {
    for (const environmentId of enabledEnvironmentIds(catalog)) {
      const state = appAtomRegistry.get(
        environmentShell.stateValueAtom(environmentId as EnvironmentId),
      );
      shells.set(
        String(environmentId),
        state.status === "live" ? "live" : Option.isSome(state.error) ? "failed" : "waiting",
      );
    }
  }
  return {
    at: Date.now() - startedMs,
    cachesRead: appAtomRegistry.get(shellCachesReadAtom),
    shells,
  };
}

async function appendRecord(record: LaunchTimingRecord): Promise<void> {
  const file = new File(Paths.document, TIMING_FILE);
  const previous = file.exists ? (await file.text()).split("\n").filter(Boolean) : [];
  const lines = [...previous, JSON.stringify(record)].slice(-KEEP_LINES);
  await writeFileAtomically(file, `${lines.join("\n")}\n`);
}

/** Starts the launch measurement once; returns its disposer. */
export function installLaunchTiming(): () => void {
  const startedAt = new Date();
  const startedMs = startedAt.getTime();
  const samples: LaunchTimingSample[] = [];
  let done = false;
  const finish = () => {
    if (done) return;
    done = true;
    clearInterval(poll);
    clearTimeout(limit);
    void appendRecord(launchTimingRecord(startedAt, samples)).catch(() => {});
  };
  // A light poll instead of subscriptions: it must not keep any shell atom mounted on its own.
  const poll = setInterval(() => {
    const sample = sampleNow(startedMs);
    samples.push(sample);
    if (launchTimingSettled(sample)) finish();
  }, 100);
  const limit = setTimeout(finish, SETTLE_LIMIT_MS);
  return () => {
    done = true;
    clearInterval(poll);
    clearTimeout(limit);
  };
}
