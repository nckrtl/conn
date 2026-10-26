import { act, type PointerEvent, useLayoutEffect } from "react";
import { create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";

import { useResizeDrag } from "./useResizeDrag";

let renderer: ReactTestRenderer | undefined;
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const events = new EventTarget();
  vi.stubGlobal("window", events);
  vi.stubGlobal("document", { body: { style: { removeProperty: vi.fn() } } });
});
afterEach(async () => {
  await act(async () => renderer?.unmount());
  vi.unstubAllGlobals();
});

it.each([
  ["left", 350],
  ["right", 450],
  ["top", 320],
  ["bottom", 480],
] as const)("resizes from the %s edge using the correct axis and direction", async (edge, size) => {
  const finish = vi.fn();
  let handlers: ReturnType<typeof useResizeDrag<HTMLDivElement>>;
  function Probe() {
    const value = useResizeDrag<HTMLDivElement>(() => ({
      width: 400,
      edge,
      bounds: { min: 0, max: 1_000 },
      resize: (value) => value,
      finish,
    }));
    useLayoutEffect(() => {
      handlers = value;
    });
    return null;
  }
  await act(async () => {
    renderer = create(<Probe />);
  });
  const target = {
    setPointerCapture: vi.fn(),
    hasPointerCapture: () => true,
    releasePointerCapture: vi.fn(),
  };
  const event = (clientX: number, clientY: number) =>
    ({
      button: 0,
      pointerId: 1,
      clientX,
      clientY,
      currentTarget: target,
      preventDefault: vi.fn(),
      stopPropagation: vi.fn(),
    }) as unknown as PointerEvent<HTMLDivElement>;
  await act(async () => handlers.onPointerDown(event(100, 100)));
  await act(async () => handlers.onPointerUp(event(150, 180)));
  expect(finish).toHaveBeenCalledWith(size, true);
  expect(target.releasePointerCapture).toHaveBeenCalledWith(1);
});
