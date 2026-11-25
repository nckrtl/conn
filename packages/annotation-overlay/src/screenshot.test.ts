import { afterEach, expect, it, vi } from "vite-plus/test";
import { configureHostHooks, type CaptureHook } from "./hooks";
import { captureAnnotationScreenshot } from "./screenshot";
import type { AnnotationDraft } from "./types";

const draft: AnnotationDraft = {
  x: 0,
  y: 0,
  clientX: 0,
  clientY: 0,
  element: "button",
  elementPath: "button",
  boundingBox: { x: 0, y: 0, width: 20, height: 20 },
  isFixed: false,
  comment: "",
  url: "https://example.test",
  pathname: "/",
};

function pendingImage() {
  let resolve!: (image: string) => void;
  const promise = new Promise<string>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function overlay() {
  return {
    style: {
      opacity: "",
      removeProperty() {
        this.opacity = "";
      },
    },
  };
}

function setup(capture: CaptureHook) {
  vi.useFakeTimers();
  let host = overlay();
  const frames: FrameRequestCallback[] = [];
  vi.stubGlobal("document", { getElementById: () => host });
  vi.stubGlobal("window", {
    innerWidth: 200,
    innerHeight: 200,
    scrollX: 0,
    scrollY: 0,
    setTimeout,
    clearTimeout,
    requestAnimationFrame: (frame: FrameRequestCallback) => frames.push(frame),
  });
  configureHostHooks({ capture });
  return {
    host,
    remount() {
      host = overlay();
      return host;
    },
    paint() {
      frames.shift()!(0);
      frames.shift()!(16);
    },
  };
}

afterEach(() => {
  configureHostHooks({});
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

it("discards a capture if the overlay was revealed before the compositor frames", async () => {
  const capture = vi.fn(async () => "");
  const screen = setup(capture);
  const image = captureAnnotationScreenshot(draft);
  await vi.advanceTimersByTimeAsync(1000);
  expect(screen.host.style.opacity).toBe("");
  screen.paint();
  expect(await image).toBeUndefined();
  expect(capture).not.toHaveBeenCalled();
});

it("restores the remounted overlay independently of a capture on the detached host", async () => {
  const pending = pendingImage();
  const capture = vi
    .fn<CaptureHook>()
    .mockReturnValueOnce(pending.promise)
    .mockResolvedValueOnce("");
  const screen = setup(capture);
  const first = captureAnnotationScreenshot(draft);
  screen.paint();
  await Promise.resolve();
  const secondHost = screen.remount();
  const second = captureAnnotationScreenshot(draft);
  screen.paint();
  await second;
  expect(secondHost.style.opacity).toBe("");
  expect(screen.host.style.opacity).toBe("0");
  pending.resolve("");
  await first;
  expect(screen.host.style.opacity).toBe("");
});

it("discards an in-flight host copy when the hide timeout expires", async () => {
  const pending = pendingImage();
  const capture = vi.fn(() => pending.promise);
  const screen = setup(capture);
  const image = captureAnnotationScreenshot(draft);
  screen.paint();
  await Promise.resolve();
  expect(capture).toHaveBeenCalledOnce();
  expect(screen.host.style.opacity).toBe("0");
  await vi.advanceTimersByTimeAsync(1000);
  expect(await image).toBeUndefined();
  expect(screen.host.style.opacity).toBe("");
  pending.resolve("late image");
});
