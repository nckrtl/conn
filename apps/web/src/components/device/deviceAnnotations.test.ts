import { expect, it } from "vite-plus/test";

import type { AnnotatorRecord } from "~/annotations/annotatorQueue";

import type { DeviceAxElement } from "./deviceHubApi";
import {
  DEVICE_ANNOTATION_ID,
  annotationsForPathname,
  buildDeviceAnnotationPayload,
  deviceAnnotationPathname,
  deviceAnnotationRect,
  hitTestAxElement,
} from "./deviceAnnotations";

const element = (
  id: string,
  x: number,
  y: number,
  width: number,
  height: number,
): DeviceAxElement => ({
  id,
  label: id,
  role: "Button",
  x,
  y,
  width,
  height,
});

const record = (id: string, pathname: string | undefined): AnnotatorRecord => ({
  id,
  number: 1,
  comment: "Fix it",
  status: "todo",
  ...(pathname === undefined ? {} : { pathname }),
});

it("picks the smallest element that contains the point", () => {
  const screen = element("screen", 0, 0, 1, 1);
  const button = element("button", 0.1, 0.1, 0.4, 0.4);
  const label = element("label", 0.2, 0.2, 0.1, 0.1);
  expect(hitTestAxElement([screen, button, label], 0.25, 0.25)?.id).toBe("label");
});

it("misses when no element contains the point", () => {
  expect(hitTestAxElement([element("button", 0.1, 0.1, 0.2, 0.2)], 0.9, 0.9)).toBeNull();
  expect(hitTestAxElement([], 0.5, 0.5)).toBeNull();
});

it("ignores zero-size elements", () => {
  const flat = element("flat", 0, 0, 0, 0.2);
  const line = element("line", 0, 0, 0.2, 0);
  const real = element("real", 0, 0, 0.5, 0.5);
  expect(hitTestAxElement([flat, line], 0, 0)).toBeNull();
  expect(hitTestAxElement([flat, line, real], 0.1, 0.1)?.id).toBe("real");
});

it("keeps the earlier element when two containing areas tie", () => {
  const first = element("first", 0.2, 0.2, 0.3, 0.2);
  const second = element("second", 0.25, 0.25, 0.2, 0.3);
  expect(first.width * first.height).toBe(second.width * second.height);
  expect(hitTestAxElement([first, second], 0.3, 0.3)?.id).toBe("first");
});

it("builds a device annotation and skips an empty comment", () => {
  const target = element("Sign in", 0.1, 0.2, 0.3, 0.05);
  const payload = buildDeviceAnnotationPayload({
    comment: "  Make this clearer  ",
    element: target,
    hostId: "local",
    deviceId: "UDID",
    id: "pin-1",
  });
  expect(payload).toEqual({
    id: "pin-1",
    comment: "Make this clearer",
    element: 'Button "Sign in"',
    pathname: "device/local/UDID",
    x: 0.1,
    y: 0.2,
    width: 0.3,
    height: 0.05,
  });
  expect(
    buildDeviceAnnotationPayload({
      comment: "   ",
      element: target,
      hostId: "local",
      deviceId: "UDID",
    }),
  ).toBeNull();
  expect(DEVICE_ANNOTATION_ID.test(payload!.id)).toBe(true);
});

it("rejects an id the annotator would refuse and generates a valid one", () => {
  const target = element("Go", 0, 0, 0.2, 0.2);
  expect(
    buildDeviceAnnotationPayload({
      comment: "Now",
      element: target,
      hostId: "local",
      deviceId: "1",
      id: "has space",
    }),
  ).toBeNull();
  const generated = buildDeviceAnnotationPayload({
    comment: "Now",
    element: target,
    hostId: "local",
    deviceId: "1",
  });
  expect(generated?.id).toMatch(DEVICE_ANNOTATION_ID);
  expect(generated?.pathname).toBe(deviceAnnotationPathname("local", "1"));
});

it("keeps one device's annotations and only rects that can be drawn", () => {
  const pathname = deviceAnnotationPathname("local", "phone");
  const mine = record("a", pathname);
  const other = record("b", "device/local/other");
  const legacy = record("c", undefined);
  expect(annotationsForPathname([mine, other, legacy], pathname)).toEqual([mine]);
  expect(deviceAnnotationRect({ ...mine, x: 0.1, y: 0.2, width: 0.3, height: 0.4 })).toEqual({
    x: 0.1,
    y: 0.2,
    width: 0.3,
    height: 0.4,
  });
  expect(deviceAnnotationRect({ ...mine, x: 0.1, y: 0.2, width: 0, height: 0.4 })).toBeNull();
  expect(deviceAnnotationRect(mine)).toBeNull();
});
