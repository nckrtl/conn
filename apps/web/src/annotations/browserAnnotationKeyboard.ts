export function isAnnotationToggleShortcut(event: {
  key: string;
  metaKey: boolean;
  ctrlKey: boolean;
  shiftKey: boolean;
  altKey: boolean;
}): boolean {
  return (
    (event.metaKey || event.ctrlKey) &&
    event.shiftKey &&
    !event.altKey &&
    event.key.toLowerCase() === "a"
  );
}

/** Claim browser annotation keys before the shell or the streamed page handles them. */
export function handleBrowserAnnotationKey(
  event: KeyboardEvent,
  state: { focused: boolean; active: boolean; disabled: boolean },
  setMode: (active: boolean) => void,
): void {
  if (state.disabled || event.isComposing || !state.focused) return;
  const toggle = isAnnotationToggleShortcut(event);
  const stop = event.key === "Escape" && !event.shiftKey && state.active;
  if (!toggle && !stop) return;
  event.preventDefault();
  event.stopImmediatePropagation();
  if (!event.repeat) setMode(toggle ? !state.active : false);
}
