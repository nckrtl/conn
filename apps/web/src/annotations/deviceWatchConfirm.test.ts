import { expect, it } from "vite-plus/test";

import {
  DEVICE_WATCH_CONFIRM_RETRY_MS,
  type DeviceWatchConfirmEntry,
  type DeviceWatchConfirmFlight,
  deviceWatchConfirmKey,
  startDeviceWatchConfirm,
} from "./deviceWatchConfirm";

const device = { hostId: "local", deviceId: "UDID" };
const savedUrl = "http://127.0.0.1:9/annotations";

function flush(): Promise<void> {
  return Promise.resolve()
    .then(() => undefined)
    .then(() => undefined)
    .then(() => undefined)
    .then(() => undefined)
    .then(() => undefined);
}

it("retries a failed confirm without a new device snapshot", async () => {
  const flight: DeviceWatchConfirmFlight = { key: null, token: 0 };
  const entry = { annotationsUrl: savedUrl, device };
  let calls = 0;
  let finishFirst: (url: string | null) => void = () => undefined;
  const noted: string[] = [];
  const delays: number[] = [];
  const queued: Array<() => void> = [];

  startDeviceWatchConfirm({
    device,
    annotationsUrl: savedUrl,
    flight,
    confirm: () => {
      calls += 1;
      if (calls === 1) {
        return new Promise<string | null>((resolve) => {
          finishFirst = resolve;
        });
      }
      return Promise.resolve(savedUrl);
    },
    readEntry: () => entry,
    note: (url) => {
      noted.push(url);
    },
    schedule: (delayMs, run) => {
      delays.push(delayMs);
      queued.push(run);
      return () => {
        queued.length = 0;
      };
    },
  });

  expect(flight.key).toBe(deviceWatchConfirmKey(device, savedUrl));
  finishFirst(null);
  await flush();
  expect(flight.key).toBeNull();
  expect(calls).toBe(1);
  expect(delays).toEqual([DEVICE_WATCH_CONFIRM_RETRY_MS]);
  expect(noted).toEqual([]);

  queued[0]?.();
  expect(flight.key).toBe(deviceWatchConfirmKey(device, savedUrl));
  await flush();
  expect(calls).toBe(2);
  expect(noted).toEqual([savedUrl]);
  expect(flight.key).toBeNull();
  expect(delays).toEqual([DEVICE_WATCH_CONFIRM_RETRY_MS]);
});

it("does not retry a removed or replaced watch", async () => {
  const flight: DeviceWatchConfirmFlight = { key: null, token: 0 };
  let entry: DeviceWatchConfirmEntry | null = { annotationsUrl: savedUrl, device };
  let calls = 0;
  const queued: Array<() => void> = [];

  startDeviceWatchConfirm({
    device,
    annotationsUrl: savedUrl,
    flight,
    confirm: () => {
      calls += 1;
      return Promise.reject(new Error("missing"));
    },
    readEntry: () => entry,
    note: () => {
      throw new Error("removed watch was confirmed");
    },
    schedule: (_delayMs, run) => {
      queued.push(run);
      return () => {
        queued.length = 0;
      };
    },
  });

  await flush();
  expect(calls).toBe(1);
  expect(flight.key).toBeNull();
  entry = null;
  queued[0]?.();
  await flush();
  expect(calls).toBe(1);

  entry = { annotationsUrl: savedUrl, device };
  const replaced: Array<() => void> = [];
  startDeviceWatchConfirm({
    device,
    annotationsUrl: savedUrl,
    flight,
    confirm: () => {
      calls += 1;
      return Promise.resolve(null);
    },
    readEntry: () => entry,
    note: () => {
      throw new Error("replaced watch was confirmed");
    },
    schedule: (_delayMs, run) => {
      replaced.push(run);
      return () => {
        replaced.length = 0;
      };
    },
  });
  await flush();
  entry = { annotationsUrl: "http://127.0.0.1:10/annotations", device };
  replaced[0]?.();
  await flush();
  expect(calls).toBe(2);
});

it("does not fire a stale attempt after cancel", async () => {
  const flight: DeviceWatchConfirmFlight = { key: null, token: 0 };
  let calls = 0;
  const queued: Array<() => void> = [];

  const cancel = startDeviceWatchConfirm({
    device,
    annotationsUrl: savedUrl,
    flight,
    confirm: () => {
      calls += 1;
      return Promise.resolve(null);
    },
    readEntry: () => ({ annotationsUrl: savedUrl, device }),
    note: () => {
      throw new Error("cancelled watch was confirmed");
    },
    schedule: (_delayMs, run) => {
      queued.push(run);
      return () => {
        queued.length = 0;
      };
    },
  });

  await flush();
  const stale = queued[0];
  cancel();
  expect(queued).toEqual([]);
  expect(flight.key).toBeNull();
  stale?.();
  await flush();
  expect(calls).toBe(1);
});
