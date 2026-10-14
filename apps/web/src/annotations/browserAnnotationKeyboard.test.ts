import { describe, expect, it, vi } from "vite-plus/test";
import { handleBrowserAnnotationKey } from "./browserAnnotationKeyboard";

function key(key: string, options: Partial<KeyboardEvent> = {}): KeyboardEvent {
  return Object.assign(new Event("keydown", { cancelable: true }), {
    key,
    metaKey: false,
    ctrlKey: false,
    shiftKey: false,
    altKey: false,
    repeat: false,
    isComposing: false,
    ...options,
  }) as KeyboardEvent;
}

describe("browser annotation keyboard ownership", () => {
  it("stops annotation on Escape before page or shell shortcuts see it", () => {
    const target = new EventTarget();
    const setMode = vi.fn();
    const shell = vi.fn();
    target.addEventListener("keydown", (event) =>
      handleBrowserAnnotationKey(
        event as KeyboardEvent,
        { focused: true, active: true, disabled: false },
        setMode,
      ),
    );
    target.addEventListener("keydown", shell);
    const event = key("Escape");
    target.dispatchEvent(event);
    expect(setMode).toHaveBeenCalledWith(false);
    expect(event.defaultPrevented).toBe(true);
    expect(shell).not.toHaveBeenCalled();
  });

  it("toggles with Command or Control Shift A without leaking to composer mode", () => {
    for (const modifiers of [{ metaKey: true }, { ctrlKey: true }]) {
      const setMode = vi.fn();
      const event = key("A", { ...modifiers, shiftKey: true });
      handleBrowserAnnotationKey(event, { focused: true, active: false, disabled: false }, setMode);
      expect(setMode).toHaveBeenCalledWith(true);
      expect(event.defaultPrevented).toBe(true);
    }
  });

  it("consumes key repeats without toggling annotation again", () => {
    const setMode = vi.fn();
    const event = key("A", { metaKey: true, shiftKey: true, repeat: true });
    handleBrowserAnnotationKey(event, { focused: true, active: true, disabled: false }, setMode);
    expect(setMode).not.toHaveBeenCalled();
    expect(event.defaultPrevented).toBe(true);
  });

  it("leaves other focus owners, non-controlling viewers, and inactive Escape alone", () => {
    const setMode = vi.fn();
    for (const state of [
      { focused: false, active: true, disabled: false },
      { focused: true, active: true, disabled: true },
      { focused: true, active: false, disabled: false },
    ]) {
      const event = key("Escape");
      handleBrowserAnnotationKey(event, state, setMode);
      expect(event.defaultPrevented).toBe(false);
    }
    expect(setMode).not.toHaveBeenCalled();
  });
});
