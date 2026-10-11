import type { AnnotatorRecord } from "~/annotations/annotatorQueue";
import { randomUUID } from "~/lib/utils";

import type { DeviceAxElement } from "./deviceHubApi";

/** Same rule the annotator enforces for `id`. */
export const DEVICE_ANNOTATION_ID = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,199}$/;

export function deviceAnnotationPathname(hostId: string, deviceId: string): string {
  return `device/${hostId}/${deviceId}`;
}

export function annotationsForPathname(
  annotations: ReadonlyArray<AnnotatorRecord>,
  pathname: string,
): AnnotatorRecord[] {
  return annotations.filter((annotation) => annotation.pathname === pathname);
}

/** Role and label, short enough to read in the queue and in the agent's claim. */
export function describeDeviceElement(element: Pick<DeviceAxElement, "role" | "label">): string {
  const role = element.role.trim();
  const label = element.label.trim();
  if (role && label) return `${role} "${label}"`;
  return role || label || "element";
}

export interface DeviceAnnotationRect {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

export function deviceAnnotationRect(annotation: AnnotatorRecord): DeviceAnnotationRect | null {
  const { x, y, width, height } = annotation;
  if (
    typeof x !== "number" ||
    typeof y !== "number" ||
    typeof width !== "number" ||
    typeof height !== "number" ||
    !Number.isFinite(x) ||
    !Number.isFinite(y) ||
    !Number.isFinite(width) ||
    !Number.isFinite(height) ||
    width <= 0 ||
    height <= 0
  ) {
    return null;
  }
  return { x, y, width, height };
}

export interface DeviceAnnotationPayload extends DeviceAnnotationRect {
  readonly id: string;
  readonly comment: string;
  readonly element: string;
  readonly pathname: string;
}

/** `null` when the comment is empty or the id would be rejected. Nothing is created then. */
export function buildDeviceAnnotationPayload(input: {
  readonly comment: string;
  readonly element: DeviceAxElement;
  readonly hostId: string;
  readonly deviceId: string;
  readonly id?: string;
}): DeviceAnnotationPayload | null {
  const comment = input.comment.trim();
  if (comment === "") return null;
  const id = input.id ?? randomUUID();
  if (!DEVICE_ANNOTATION_ID.test(id)) return null;
  return {
    id,
    comment,
    element: describeDeviceElement(input.element),
    pathname: deviceAnnotationPathname(input.hostId, input.deviceId),
    x: input.element.x,
    y: input.element.y,
    width: input.element.width,
    height: input.element.height,
  };
}

/**
 * The containing element with the smallest area. Equal areas keep the earlier element.
 * Zero-size frames are not targets.
 */
export function hitTestAxElement(
  elements: ReadonlyArray<DeviceAxElement>,
  x: number,
  y: number,
): DeviceAxElement | null {
  let best: DeviceAxElement | null = null;
  let bestArea = Number.POSITIVE_INFINITY;
  for (const element of elements) {
    if (!(element.width > 0) || !(element.height > 0)) continue;
    if (!Number.isFinite(element.x) || !Number.isFinite(element.y)) continue;
    if (
      x < element.x ||
      y < element.y ||
      x > element.x + element.width ||
      y > element.y + element.height
    ) {
      continue;
    }
    const area = element.width * element.height;
    if (!Number.isFinite(area) || area >= bestArea) continue;
    best = element;
    bestArea = area;
  }
  return best;
}
