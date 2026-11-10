import { useRef } from "react";
import { describe, expect, it, vi } from "vite-plus/test";

import { act, render, stubGlobal } from "../../../test/render";
import { useToolbarPanelResize } from "./panelResize";

const storageKey = "t3code:laravel-toolbar-panel-height";

// Owns the saved height for one test and counts the writes the hook makes.
function savedHeight(stored?: string) {
  if (stored === undefined) localStorage.removeItem(storageKey);
  else localStorage.setItem(storageKey, stored);
  const setItem = vi.spyOn(Storage.prototype, "setItem");
  return {
    setItem,
    get value() {
      return localStorage.getItem(storageKey);
    },
    [Symbol.dispose]() {
      setItem.mockRestore();
      localStorage.removeItem(storageKey);
    },
  };
}

// Queues frames without running them, so a test sees whether a drag left one behind.
function queuedFrames() {
  const frames = new Map<number, FrameRequestCallback>();
  let frameId = 0;
  const request = stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
    frames.set(++frameId, callback);
    return frameId;
  });
  const cancel = stubGlobal("cancelAnimationFrame", (id: number) => frames.delete(id));
  return {
    frames,
    [Symbol.dispose]() {
      cancel[Symbol.dispose]();
      request[Symbol.dispose]();
    },
  };
}

// The page sits directly above the toolbar host, so its height is the space a panel can use.
function Toolbar({ pin }: { pin: () => void }) {
  const hostRef = useRef<HTMLDivElement>(null);
  const resize = useToolbarPanelResize(hostRef, pin);
  return (
    <div>
      <div data-testid="page" style={{ height: 660 }} />
      <div ref={hostRef}>
        <div
          data-testid="handle"
          tabIndex={0}
          data-height={resize.height}
          data-min={resize.minHeight}
          data-max={resize.maxHeight}
          onKeyDown={resize.onKeyDown}
          {...resize.handlers}
        >
          <button type="button">Pin</button>
        </div>
      </div>
    </div>
  );
}

async function mount(pin = vi.fn()) {
  const screen = await render(<Toolbar pin={pin} />, { router: false });
  const handle = screen.getByTestId("handle");
  const element = handle.element() as HTMLDivElement;
  // A synthetic pointer has no active pointer for the browser to capture.
  let captured = false;
  Object.assign(element, {
    setPointerCapture: () => {
      captured = true;
    },
    hasPointerCapture: () => captured,
    releasePointerCapture: () => {
      captured = false;
    },
  });
  const page = screen.getByTestId("page").element() as HTMLDivElement;
  return {
    screen,
    handle,
    element,
    page,
    pin,
    [Symbol.asyncDispose]: () => screen[Symbol.asyncDispose](),
  };
}

const pointer = (type: string, clientY: number, clientX = 100) =>
  new PointerEvent(type, {
    bubbles: true,
    cancelable: true,
    button: 0,
    pointerId: 1,
    clientX,
    clientY,
  });

const key = (key: string) => new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true });

describe("toolbar panel resizing", () => {
  it("grows upward and persists the final position even before a queued frame runs", async () => {
    using saved = savedHeight();
    using queued = queuedFrames();
    {
      await using toolbar = await mount();
      const { element, handle } = toolbar;
      await act(() => element.dispatchEvent(pointer("pointerdown", 400)));
      expect(toolbar.pin).toHaveBeenCalledTimes(1);
      await act(() => element.dispatchEvent(pointer("pointermove", 320, 900)));
      expect(saved.setItem).not.toHaveBeenCalled();
      await act(() => element.dispatchEvent(pointer("pointerup", 280)));
      await expect.element(handle).toHaveAttribute("data-height", "504");
      expect(saved.value).toBe("504");
      expect(saved.setItem).toHaveBeenCalledTimes(1);
      expect(queued.frames.size).toBe(0);
    }
    await using remounted = await mount();
    await expect.element(remounted.handle).toHaveAttribute("data-height", "504");
  });

  it("fits small page areas without overwriting the saved height", async () => {
    using saved = savedHeight("500");
    await using toolbar = await mount();
    await expect.element(toolbar.handle).toHaveAttribute("data-max", "648");
    toolbar.page.style.height = "140px";
    await expect.element(toolbar.handle).toHaveAttribute("data-height", "128");
    await expect.element(toolbar.handle).toHaveAttribute("data-min", "128");
    expect(saved.value).toBe("500");
    toolbar.page.style.height = "660px";
    await expect.element(toolbar.handle).toHaveAttribute("data-height", "500");
  });

  it("clamps keyboard resizing and saves it across remounts", async () => {
    using _saved = savedHeight();
    {
      await using toolbar = await mount();
      const { element, handle } = toolbar;
      await act(() => element.dispatchEvent(key("End")));
      await expect.element(handle).toHaveAttribute("data-height", "648");
      await act(() => element.dispatchEvent(key("ArrowUp")));
      await expect.element(handle).toHaveAttribute("data-height", "648");
      await act(() => element.dispatchEvent(key("Home")));
      await expect.element(handle).toHaveAttribute("data-height", "192");
    }
    await using remounted = await mount();
    await expect.element(remounted.handle).toHaveAttribute("data-height", "192");
  });

  it("ignores header controls and invalid persisted values", async () => {
    using saved = savedHeight('"bad height"');
    await using toolbar = await mount();
    await expect.element(toolbar.handle).toHaveAttribute("data-height", "384");
    const button = toolbar.screen.getByRole("button", { name: "Pin" }).element();
    await act(() => button.dispatchEvent(pointer("pointerdown", 400)));
    expect(toolbar.pin).not.toHaveBeenCalled();
    expect(saved.setItem).not.toHaveBeenCalled();
    expect(document.body.style.cursor).toBe("");
  });
});
