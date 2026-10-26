import * as Schema from "effect/Schema";
import {
  createContext,
  type KeyboardEvent,
  type RefObject,
  useLayoutEffect,
  useRef,
  useState,
} from "react";

import { getLocalStorageItem, setLocalStorageItem } from "~/hooks/useLocalStorage";
import { useResizeDrag } from "~/hooks/useResizeDrag";

const STORAGE_KEY = "t3code:laravel-toolbar-panel-height";
const DEFAULT_HEIGHT = 384;
const MIN_HEIGHT = 192;
/** The floating sheet keeps this gap to the page edges and the bar (the bar's own side padding). */
export const TOOLBAR_SHEET_INSET = 6;

function readHeight() {
  try {
    const stored = getLocalStorageItem(STORAGE_KEY, Schema.Finite);
    return stored !== null && stored > 0 ? stored : DEFAULT_HEIGHT;
  } catch {
    return DEFAULT_HEIGHT;
  }
}

function saveHeight(height: number) {
  try {
    setLocalStorageItem(STORAGE_KEY, height, Schema.Finite);
  } catch {
    // Resizing still works when browser storage is unavailable.
  }
}

/** All flyouts share a preferred height, clamped to the browser's page area. */
export function useToolbarPanelResize(
  hostRef: RefObject<HTMLDivElement | null>,
  pinPanel: () => void,
) {
  const [preferredHeight, setPreferredHeight] = useState(readHeight);
  const [availableHeight, setAvailableHeight] = useState(DEFAULT_HEIGHT);
  useLayoutEffect(() => {
    const host = hostRef.current;
    const parent = host?.parentElement;
    if (!host || !parent) return;
    const page = host.previousElementSibling ?? parent;
    const measure = () => {
      setAvailableHeight(
        Math.max(
          0,
          Math.floor(host.getBoundingClientRect().top - page.getBoundingClientRect().top) -
            2 * TOOLBAR_SHEET_INSET,
        ),
      );
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(parent);
    observer.observe(page);
    observer.observe(host);
    return () => observer.disconnect();
  }, [hostRef]);

  const minHeight = Math.min(MIN_HEIGHT, availableHeight);
  const clamp = (value: number) => Math.max(minHeight, Math.min(availableHeight, value));
  const height = clamp(preferredHeight);
  const clampRef = useRef(clamp);
  useLayoutEffect(() => {
    clampRef.current = clamp;
  });

  const handlers = useResizeDrag<HTMLDivElement>((event) => {
    if (
      event.target instanceof Element &&
      event.target.closest("button, a, input, select, textarea, [role=button]")
    ) {
      return null;
    }
    pinPanel();
    return {
      width: height,
      edge: "top",
      bounds: { min: minHeight, max: availableHeight },
      resize(value) {
        const nextHeight = clampRef.current(value);
        setPreferredHeight(nextHeight);
        return nextHeight;
      },
      finish(finalHeight, moved) {
        if (moved) saveHeight(finalHeight);
      },
    };
  });

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    let nextHeight: number;
    const step = event.shiftKey ? 40 : 10;
    switch (event.key) {
      case "ArrowUp":
        nextHeight = height + step;
        break;
      case "ArrowDown":
        nextHeight = height - step;
        break;
      case "Home":
        nextHeight = minHeight;
        break;
      case "End":
        nextHeight = availableHeight;
        break;
      default:
        return;
    }
    event.preventDefault();
    pinPanel();
    const clamped = clamp(nextHeight);
    setPreferredHeight(clamped);
    saveHeight(clamped);
  };

  return { height, minHeight, maxHeight: availableHeight, handlers, onKeyDown };
}

export const ToolbarPanelResizeContext = createContext<ReturnType<
  typeof useToolbarPanelResize
> | null>(null);
