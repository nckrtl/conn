/** Pause before the next confirm so a missing annotator does not spin. */
export const DEVICE_WATCH_CONFIRM_RETRY_MS = 2_000;

export interface DeviceWatchConfirmDevice {
  readonly hostId: string;
  readonly deviceId: string;
}

export interface DeviceWatchConfirmEntry {
  readonly annotationsUrl: string;
  readonly device?: DeviceWatchConfirmDevice;
}

/** Set only while `device.annotator` has not settled. */
export interface DeviceWatchConfirmFlight {
  key: string | null;
  token: number;
}

export function deviceWatchConfirmKey(
  device: DeviceWatchConfirmDevice,
  annotationsUrl: string,
): string {
  return `${device.hostId}\0${device.deviceId}\0${annotationsUrl}`;
}

export function deviceWatchEntryMatches(
  entry: DeviceWatchConfirmEntry | null | undefined,
  device: DeviceWatchConfirmDevice,
  annotationsUrl: string,
): boolean {
  return (
    entry?.device?.hostId === device.hostId &&
    entry.device.deviceId === device.deviceId &&
    entry.annotationsUrl === annotationsUrl
  );
}

/**
 * Ask `device.annotator` for this saved watch.
 * A thrown call or a missing URL schedules one later attempt while the saved
 * entry is still this device and URL. Success does not. The returned function
 * drops a pending attempt and ignores a result from the call it cancelled.
 */
export function startDeviceWatchConfirm(input: {
  readonly device: DeviceWatchConfirmDevice;
  readonly annotationsUrl: string;
  readonly flight: DeviceWatchConfirmFlight;
  readonly confirm: () => Promise<string | null>;
  readonly readEntry: () => DeviceWatchConfirmEntry | null | undefined;
  readonly note: (annotationsUrl: string) => void;
  readonly schedule: (delayMs: number, run: () => void) => () => void;
  readonly delayMs?: number;
}): () => void {
  let cancelled = false;
  let cancelRetry: (() => void) | null = null;
  const key = deviceWatchConfirmKey(input.device, input.annotationsUrl);
  const delayMs = input.delayMs ?? DEVICE_WATCH_CONFIRM_RETRY_MS;

  const cancel = () => {
    if (cancelled) return;
    cancelled = true;
    input.flight.token += 1;
    cancelRetry?.();
    cancelRetry = null;
    if (input.flight.key === key) input.flight.key = null;
  };

  const attempt = () => {
    if (cancelled || input.flight.key === key) return;
    if (!deviceWatchEntryMatches(input.readEntry(), input.device, input.annotationsUrl)) return;
    const token = ++input.flight.token;
    input.flight.key = key;
    // `confirm` runs now so a throw and an in-flight marker share this attempt.
    let pending: Promise<string | null>;
    try {
      pending = input.confirm();
    } catch {
      pending = Promise.resolve(null);
    }
    void pending
      .then(
        (url) => url,
        () => null,
      )
      .then((url) => {
        if (input.flight.token !== token) return;
        input.flight.key = null;
        if (cancelled) return;
        if (!deviceWatchEntryMatches(input.readEntry(), input.device, input.annotationsUrl)) {
          return;
        }
        if (url !== null) {
          input.note(url);
          return;
        }
        cancelRetry = input.schedule(delayMs, () => {
          cancelRetry = null;
          attempt();
        });
      });
  };

  attempt();
  return cancel;
}
