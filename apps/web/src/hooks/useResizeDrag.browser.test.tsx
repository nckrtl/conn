import { expect, it, vi } from "vite-plus/test";

import { act, render } from "../../test/render";
import { useResizeDrag } from "./useResizeDrag";

const pointer = (type: string, clientX: number, clientY: number) =>
  new PointerEvent(type, {
    bubbles: true,
    cancelable: true,
    button: 0,
    pointerId: 1,
    clientX,
    clientY,
  });

it.each([
  ["left", 350],
  ["right", 450],
  ["top", 320],
  ["bottom", 480],
] as const)("resizes from the %s edge using the correct axis and direction", async (edge, size) => {
  const finish = vi.fn();
  function Handle() {
    const {
      cancel: _cancel,
      refresh: _refresh,
      ...handlers
    } = useResizeDrag<HTMLDivElement>(() => ({
      width: 400,
      edge,
      bounds: { min: 0, max: 1_000 },
      resize: (value) => value,
      finish,
    }));
    return <div data-testid="handle" {...handlers} />;
  }
  await using screen = await render(<Handle />, { router: false });
  const handle = screen.getByTestId("handle").element() as HTMLDivElement;
  // A synthetic pointer has no active pointer for the browser to capture.
  let captured = false;
  const releasePointerCapture = vi.fn(() => {
    captured = false;
  });
  Object.assign(handle, {
    setPointerCapture: () => {
      captured = true;
    },
    hasPointerCapture: () => captured,
    releasePointerCapture,
  });
  await act(() => handle.dispatchEvent(pointer("pointerdown", 100, 100)));
  expect(document.body.style.cursor).toBe(
    edge === "top" || edge === "bottom" ? "row-resize" : "col-resize",
  );
  await act(() => handle.dispatchEvent(pointer("pointerup", 150, 180)));
  expect(finish).toHaveBeenCalledWith(size, true);
  expect(releasePointerCapture).toHaveBeenCalledWith(1);
  expect(document.body.style.cursor).toBe("");
});
