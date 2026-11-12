import { describe, expect, it } from "vite-plus/test";

import { createSerialRunner } from "./serialRunner";

// Every step of the runner is a promise continuation, so draining microtasks settles it.
const settle = async () => {
  for (let turn = 0; turn < 20; turn += 1) await Promise.resolve();
};

function slowTask() {
  const log = { started: 0, finished: 0, maxInFlight: 0 };
  let inFlight = 0;
  const releases: (() => void)[] = [];
  const task = async () => {
    log.started += 1;
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
    void trigger();
    void trigger();
    void trigger();
    void trigger();
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
    void trigger();
    release();
    await settle();
    expect(log.started).toBe(1);
  });

  it("settles a trigger only after a run that started after it, and survives a failing run", async () => {
    let fail = true;
    let runs = 0;
    const releases: (() => void)[] = [];
    const trigger = createSerialRunner(async () => {
      runs += 1;
      await new Promise<void>((resolve) => releases.push(resolve));
      if (fail) {
        fail = false;
        throw new Error("gateway down");
      }
    });
    const first = trigger();
    let secondDone = false;
    const second = trigger().then(() => {
      secondDone = true;
    });
    releases.shift()?.();
    await first;
    await settle();
    // The first run failed and ended; the second trigger waits for the follow-up run.
    expect(runs).toBe(2);
    expect(secondDone).toBe(false);
    releases.shift()?.();
    await second;
    expect(secondDone).toBe(true);
    void trigger();
    await settle();
    expect(runs).toBe(3);
  });
});
