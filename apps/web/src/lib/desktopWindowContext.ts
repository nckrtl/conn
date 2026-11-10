// rooms-patches: extra desktop windows. The main window owns app activation,
// notifications and the persisted selections; extra windows share drafts,
// workspaces and sidebar state through localStorage `storage` events.

export interface DesktopWindowContext {
  /** True in a window opened with File → New Window or from the workspace rail. */
  readonly additional: boolean;
  /** The workspace (id or name) the extra window starts on; null = all projects. */
  readonly workspace: string | null;
}

const MAIN_WINDOW: DesktopWindowContext = { additional: false, workspace: null };

export function readDesktopWindowContext(): DesktopWindowContext {
  if (typeof window === "undefined") return MAIN_WINDOW;
  return window.desktopBridge?.windowContext ?? MAIN_WINDOW;
}

export function isAdditionalDesktopWindow(): boolean {
  return readDesktopWindowContext().additional;
}

/** True when this shell can open extra windows. */
export function canOpenDesktopWindows(): boolean {
  return typeof window !== "undefined" && window.desktopBridge?.openWorkspaceWindow !== undefined;
}

/** Opens an extra window on a workspace (id or name; null = all projects). */
export function openDesktopWorkspaceWindow(workspace: string | null): void {
  void window.desktopBridge?.openWorkspaceWindow?.(workspace);
}

/**
 * Calls `onChange` with the new value when another window writes `key`.
 * Removals are ignored. Returns the unsubscribe function.
 */
export function onOtherWindowStorageChange(
  key: string,
  onChange: (newValue: string) => void,
): () => void {
  if (typeof window === "undefined" || typeof window.addEventListener !== "function") {
    return () => {};
  }
  const listener = (event: StorageEvent) => {
    if (event.storageArea !== window.localStorage) return;
    if (event.key !== key || event.newValue === null) return;
    onChange(event.newValue);
  };
  window.addEventListener("storage", listener);
  return () => window.removeEventListener("storage", listener);
}

/**
 * Tracks which keys this window changed recently. A change from another
 * window must not overwrite a key the user is editing here: this window's
 * version is newer and reaches storage with its next write.
 */
export class RecentKeyChanges {
  private readonly changedAt = new Map<string, number>();

  constructor(
    private readonly windowMs: number,
    private readonly now: () => number = Date.now,
  ) {}

  mark(key: string): void {
    this.changedAt.set(key, this.now());
  }

  has(key: string): boolean {
    const at = this.changedAt.get(key);
    if (at === undefined) return false;
    if (this.now() - at > this.windowMs) {
      this.changedAt.delete(key);
      return false;
    }
    return true;
  }
}

/** Marks every key whose value object changed between two record snapshots. */
export function markChangedRecordKeys(
  changes: RecentKeyChanges,
  prefix: string,
  previous: Readonly<Record<string, unknown>>,
  next: Readonly<Record<string, unknown>>,
): void {
  if (previous === next) return;
  for (const key of Object.keys(next)) {
    if (previous[key] !== next[key]) changes.mark(prefix + key);
  }
  for (const key of Object.keys(previous)) {
    if (!(key in next)) changes.mark(prefix + key);
  }
}

/**
 * Merges another window's keyed record into ours: recently changed local keys win, others take
 * the incoming value, and removed keys go. `local` is the persisted form (equal JSON = no change).
 * Returns keys to replace, keys to remove, and whether this window holds newer values.
 */
export function diffIncomingRecord<V>(
  local: Readonly<Record<string, V>>,
  incoming: Readonly<Record<string, V>>,
  isLocallyChanged: (key: string) => boolean,
): {
  readonly replace: ReadonlyArray<readonly [string, V]>;
  readonly remove: readonly string[];
  readonly localAhead: boolean;
} {
  const same = (key: string) =>
    key in local && key in incoming && JSON.stringify(local[key]) === JSON.stringify(incoming[key]);
  const replace: Array<readonly [string, V]> = [];
  const remove: string[] = [];
  let localAhead = false;
  for (const key of new Set([...Object.keys(local), ...Object.keys(incoming)])) {
    if (same(key)) continue;
    if (isLocallyChanged(key)) {
      localAhead = true;
    } else if (key in incoming) {
      replace.push([key, incoming[key]!]);
    } else {
      remove.push(key);
    }
  }
  return { replace, remove, localAhead };
}
