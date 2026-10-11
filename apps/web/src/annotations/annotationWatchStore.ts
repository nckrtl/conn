import { useSyncExternalStore } from "react";
import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";

import { onOtherWindowStorageChange } from "../lib/desktopWindowContext";
import { resolveStorage } from "../lib/storage";

const STORAGE_KEY = "t3code:annotation-watch:v1";

export interface AnnotationWatchDevice {
  readonly hostId: string;
  readonly deviceId: string;
}

export interface AnnotationWatchTarget {
  readonly annotationsUrl: string;
  /** Set for a device. The loopback port is not the identity. */
  readonly device?: AnnotationWatchDevice;
}

interface AnnotationWatchState {
  /** Threads in Watch mode and the annotator each one follows. */
  watchingByThreadKey: Record<string, AnnotationWatchTarget>;
  /** Annotations the last Send or Watch prompt named, per thread. */
  lastSentIdsByThreadKey: Record<string, string[]>;
  setWatching: (
    threadKey: string,
    annotationsUrl: string | null,
    device?: AnnotationWatchDevice,
  ) => void;
  /**
   * The URL `device.annotator` just returned. A persisted device URL that
   * differs is dropped; one that matches may be polled.
   */
  noteDeviceAnnotatorUrl: (
    threadKey: string,
    device: AnnotationWatchDevice,
    annotationsUrl: string,
  ) => void;
  markSent: (threadKey: string, ids: ReadonlyArray<string>) => void;
}

interface PersistedAnnotationWatch {
  readonly watchingByThreadKey: Record<string, AnnotationWatchTarget>;
  readonly lastSentIdsByThreadKey: Record<string, string[]>;
}

/**
 * Device confirmation is not persisted. A saved loopback URL is ignored until
 * this page sees that same URL from `device.annotator`.
 */
const confirmedDeviceUrls = new Map<string, string>();
const confirmationListeners = new Set<() => void>();

function emitConfirmation() {
  for (const listener of confirmationListeners) listener();
}

function writeConfirmation(threadKey: string, url: string | null) {
  const current = confirmedDeviceUrls.get(threadKey) ?? null;
  if (current === url) return;
  if (url === null) confirmedDeviceUrls.delete(threadKey);
  else confirmedDeviceUrls.set(threadKey, url);
  emitConfirmation();
}

/**
 * A rehydrate keeps a confirmation only when the saved device entry is still
 * that same URL. Any other entry was not matched in this window.
 */
export function keptDeviceWatchConfirmations(
  confirmedByThreadKey: ReadonlyMap<string, string>,
  watchingByThreadKey: Readonly<Record<string, AnnotationWatchTarget | undefined>>,
): ReadonlyMap<string, string> {
  const kept = new Map<string, string>();
  for (const [threadKey, url] of confirmedByThreadKey) {
    const entry = watchingByThreadKey[threadKey];
    if (entry?.device !== undefined && entry.annotationsUrl === url) kept.set(threadKey, url);
  }
  return kept;
}

function retainDeviceWatchConfirmation(watchingByThreadKey: Record<string, AnnotationWatchTarget>) {
  const kept = keptDeviceWatchConfirmations(confirmedDeviceUrls, watchingByThreadKey);
  if (kept.size === confirmedDeviceUrls.size) return;
  confirmedDeviceUrls.clear();
  for (const [threadKey, url] of kept) confirmedDeviceUrls.set(threadKey, url);
  emitConfirmation();
}

function subscribeConfirmation(listener: () => void) {
  confirmationListeners.add(listener);
  return () => confirmationListeners.delete(listener);
}

/** A loopback `/annotations` URL belongs to one device start, not to a page. */
export function isEphemeralDeviceAnnotatorUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    return (
      parsed.protocol === "http:" &&
      parsed.hostname === "127.0.0.1" &&
      parsed.username === "" &&
      parsed.password === "" &&
      parsed.pathname === "/annotations"
    );
  } catch {
    return false;
  }
}

export function migrateAnnotationWatchState(
  persisted: unknown,
  version: number,
): PersistedAnnotationWatch {
  const empty: PersistedAnnotationWatch = { watchingByThreadKey: {}, lastSentIdsByThreadKey: {} };
  if (persisted === null || typeof persisted !== "object") return empty;
  const record = persisted as {
    watchingByThreadKey?: Record<
      string,
      { annotationsUrl?: unknown; device?: AnnotationWatchDevice }
    >;
    lastSentIdsByThreadKey?: Record<string, string[]>;
  };
  const watchingByThreadKey: Record<string, AnnotationWatchTarget> = {};
  for (const [threadKey, entry] of Object.entries(record.watchingByThreadKey ?? {})) {
    if (typeof entry?.annotationsUrl !== "string") continue;
    // Version 1 keyed Watch by the port. That port can belong to another device now.
    if (version < 2 && isEphemeralDeviceAnnotatorUrl(entry.annotationsUrl)) continue;
    const device = entry.device;
    watchingByThreadKey[threadKey] =
      device && typeof device.hostId === "string" && typeof device.deviceId === "string"
        ? {
            annotationsUrl: entry.annotationsUrl,
            device: { hostId: device.hostId, deviceId: device.deviceId },
          }
        : { annotationsUrl: entry.annotationsUrl };
  }
  return {
    watchingByThreadKey,
    lastSentIdsByThreadKey: record.lastSentIdsByThreadKey ?? {},
  };
}

export const useAnnotationWatchStore = create<AnnotationWatchState>()(
  persist(
    (set, get) => ({
      watchingByThreadKey: {},
      lastSentIdsByThreadKey: {},
      setWatching: (threadKey, annotationsUrl, device) => {
        set((state) => {
          const watchingByThreadKey = { ...state.watchingByThreadKey };
          if (annotationsUrl === null) delete watchingByThreadKey[threadKey];
          else if (device) watchingByThreadKey[threadKey] = { annotationsUrl, device };
          else watchingByThreadKey[threadKey] = { annotationsUrl };
          return { watchingByThreadKey };
        });
        writeConfirmation(threadKey, annotationsUrl !== null && device ? annotationsUrl : null);
      },
      noteDeviceAnnotatorUrl: (threadKey, device, annotationsUrl) => {
        const current = get().watchingByThreadKey[threadKey];
        if (
          current?.device?.hostId !== device.hostId ||
          current.device.deviceId !== device.deviceId
        ) {
          return;
        }
        if (current.annotationsUrl !== annotationsUrl) {
          get().setWatching(threadKey, null);
          return;
        }
        writeConfirmation(threadKey, annotationsUrl);
      },
      markSent: (threadKey, ids) =>
        set((state) => ({
          lastSentIdsByThreadKey: { ...state.lastSentIdsByThreadKey, [threadKey]: [...ids] },
        })),
    }),
    {
      name: STORAGE_KEY,
      version: 2,
      migrate: migrateAnnotationWatchState,
      partialize: (state) => ({
        watchingByThreadKey: state.watchingByThreadKey,
        lastSentIdsByThreadKey: state.lastSentIdsByThreadKey,
      }),
      storage: createJSONStorage(() =>
        resolveStorage(typeof window !== "undefined" ? window.localStorage : undefined),
      ),
    },
  ),
);

// Another window's write rehydrates this one. Keep a device URL this window
// already matched, and drop the rest, without writing storage back.
useAnnotationWatchStore.persist.onFinishHydration((state) => {
  retainDeviceWatchConfirmation(state.watchingByThreadKey);
});

// Extra windows toggle Watch too; the main window, which sends, picks the change up.
onOtherWindowStorageChange(STORAGE_KEY, () => {
  void useAnnotationWatchStore.persist.rehydrate();
});

export function useConfirmedDeviceWatchUrl(threadKey: string): string | null {
  return useSyncExternalStore(
    subscribeConfirmation,
    () => confirmedDeviceUrls.get(threadKey) ?? null,
    () => confirmedDeviceUrls.get(threadKey) ?? null,
  );
}

/** The watch this thread may poll. A device URL is omitted until it is confirmed. */
export function useAnnotationWatch(threadKey: string): AnnotationWatchTarget | null {
  const watch = useAnnotationWatchStore((state) => state.watchingByThreadKey[threadKey] ?? null);
  const confirmed = useConfirmedDeviceWatchUrl(threadKey);
  if (watch === null) return null;
  if (watch.device && confirmed !== watch.annotationsUrl) return null;
  return watch;
}
