import { expect, it } from "vite-plus/test";

import {
  isEphemeralDeviceAnnotatorUrl,
  keptDeviceWatchConfirmations,
  migrateAnnotationWatchState,
} from "./annotationWatchStore";

it("treats only a loopback /annotations URL as a device port", () => {
  expect(isEphemeralDeviceAnnotatorUrl("http://127.0.0.1:4321/annotations")).toBe(true);
  expect(isEphemeralDeviceAnnotatorUrl("http://user:pw@127.0.0.1:4321/annotations")).toBe(false);
  expect(isEphemeralDeviceAnnotatorUrl("https://shop.test/__orbit/annotator/annotations")).toBe(
    false,
  );
  expect(isEphemeralDeviceAnnotatorUrl("http://127.0.0.1:3773/__orbit/annotator/annotations")).toBe(
    false,
  );
});

it("drops a saved device port that has no host or device", () => {
  expect(
    migrateAnnotationWatchState(
      {
        watchingByThreadKey: {
          device: { annotationsUrl: "http://127.0.0.1:4321/annotations" },
          page: { annotationsUrl: "https://shop.test/__orbit/annotator/annotations" },
        },
        lastSentIdsByThreadKey: { page: ["a"] },
      },
      1,
    ),
  ).toEqual({
    watchingByThreadKey: {
      page: { annotationsUrl: "https://shop.test/__orbit/annotator/annotations" },
    },
    lastSentIdsByThreadKey: { page: ["a"] },
  });
});

it("keeps a device confirmation when rehydrate repeats that URL", () => {
  const device = { hostId: "local", deviceId: "UDID" };
  const confirmed = new Map<string, string>([
    ["same", "http://127.0.0.1:9/annotations"],
    ["moved", "http://127.0.0.1:9/annotations"],
    ["page", "https://shop.test/__orbit/annotator/annotations"],
  ]);
  expect(
    keptDeviceWatchConfirmations(confirmed, {
      same: { annotationsUrl: "http://127.0.0.1:9/annotations", device },
      moved: { annotationsUrl: "http://127.0.0.1:10/annotations", device },
      page: { annotationsUrl: "https://shop.test/__orbit/annotator/annotations" },
    }),
  ).toEqual(new Map([["same", "http://127.0.0.1:9/annotations"]]));
});

it("keeps a device watch saved with its host and device", () => {
  const device = { hostId: "local", deviceId: "UDID" };
  expect(
    migrateAnnotationWatchState(
      {
        watchingByThreadKey: {
          device: { annotationsUrl: "http://127.0.0.1:4321/annotations", device },
        },
      },
      2,
    ),
  ).toEqual({
    watchingByThreadKey: {
      device: { annotationsUrl: "http://127.0.0.1:4321/annotations", device },
    },
    lastSentIdsByThreadKey: {},
  });
});
