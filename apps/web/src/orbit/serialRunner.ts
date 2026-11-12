/**
 * Runs the profile sync one run at a time: two runs would PATCH the same section versions and the
 * second would get a 409. Triggers during a run share one follow-up run. The promise a trigger
 * returns settles once a run that started after the trigger has finished.
 */
export function createSerialRunner(task: () => Promise<void>): () => Promise<void> {
  let running: Promise<void> | null = null;
  let followUp: Promise<void> | null = null;

  const launch = (): Promise<void> => {
    const run: Promise<void> = task()
      .catch(() => {
        // The task reports its own failures; the queue must survive them.
      })
      .then(() => {
        if (running === run) running = null;
      });
    running = run;
    return run;
  };

  return () => {
    // Between a run's end and the queued follow-up's start, `running` is null already.
    if (followUp) return followUp;
    if (running === null) return launch();
    followUp ??= running.then(() => {
      followUp = null;
      return launch();
    });
    return followUp;
  };
}
