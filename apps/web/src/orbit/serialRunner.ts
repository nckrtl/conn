import type { ProfileSyncRunOptions } from "@t3tools/client-runtime/orbit-gateway";

/**
 * Runs the profile sync one run at a time: two runs would PATCH the same section versions and the
 * second would get a 409. Triggers during a run share one follow-up run, which keeps any forced
 * push or pull among them.
 */
export function createSerialRunner(
  task: (options: ProfileSyncRunOptions | undefined) => Promise<void>,
): (options?: ProfileSyncRunOptions) => void {
  let running = false;
  let queued = false;
  let queuedOptions: ProfileSyncRunOptions | undefined;

  const trigger = (options?: ProfileSyncRunOptions): void => {
    if (running) {
      queued = true;
      if (options?.force) queuedOptions = options;
      return;
    }
    running = true;
    void task(options)
      .catch(() => {
        // The task reports its own failures; the queue must survive them.
      })
      .finally(() => {
        running = false;
        if (!queued) return;
        queued = false;
        const next = queuedOptions;
        queuedOptions = undefined;
        trigger(next);
      });
  };
  return trigger;
}
