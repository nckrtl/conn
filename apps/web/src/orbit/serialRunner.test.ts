import { describe, expect, it } from "vite-plus/test";

import { createSerialRunner } from "./serialRunner";

// Every step of the runner is a promise continuation, so draining microtasks settles it.
const settle = async () => {
  for (let turn = 0; turn < 20; turn += 1) await Promise.resolve();
};

function slowTask() {
  const log = { started: 0, finished: 0, maxInFlight: 0, options: [] as unknown[] };
  let inFlight = 0;
  const releases: (() => void)[] = [];
  const task = async (options: unknown) => {
    log.started += 1;
    log.options.push(options);
    inFlight += 1;
    log.maxInFlight = Math.max(log.maxInFlight, inFlight);
    await new Promise<void>((resolve) => releases.push(resolve));
    inFlight -= 1;
    log.finished += 1;
  };
  return { log, task, release: () => releases.shift()?.() };
}

describe("createSerialRunner", () => {
  it("never runs two at once, and folds triggers that arrive meanwhile into one follow-up", async () => {
    const { log, task, release } = slowTask();
    const trigger = createSerialRunner(task);

    // Two mounts, a focus event and a poll tick, all before the first run ends.
    trigger();
    trigger();
    trigger();
    trigger();
    await settle();
    expect(log.started).toBe(1);

    release();
    await settle();
    expect(log.started).toBe(2);
    release();
    await settle();
    expect(log.started).toBe(2);
    expect(log.finished).toBe(2);
    expect(log.maxInFlight).toBe(1);
  });

  it("starts nothing extra when no trigger came during a run", async () => {
    const { log, task, release } = slowTask();
    const trigger = createSerialRunner(task);
    trigger();
    release();
    await settle();
    expect(log.started).toBe(1);
  });

  it("keeps a forced push for the follow-up and survives a failing run", async () => {
    const seen: unknown[] = [];
    let fail = true;
    const releases: (() => void)[] = [];
    const trigger = createSerialRunner(async (options) => {
      seen.push(options);
      await new Promise<void>((resolve) => releases.push(resolve));
      if (fail) {
        fail = false;
        throw new Error("gateway down");
      }
    });
    trigger();
    trigger({ force: { push: ["appearance"] } });
    trigger();
    releases.shift()?.();
    await settle();
    expect(seen).toEqual([undefined, { force: { push: ["appearance"] } }]);
    releases.shift()?.();
    await settle();
    trigger();
    await settle();
    expect(seen).toHaveLength(3);
  });
});
