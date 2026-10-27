import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";

import { onOtherWindowStorageChange } from "../lib/desktopWindowContext";
import { resolveStorage } from "../lib/storage";
import type { AnnotationTarget } from "./useAnnotationQueue";

const STORAGE_KEY = "t3code:annotation-watch:v1";

interface AnnotationWatchState {
  /** Threads in Watch mode and the project queue each one follows. */
  watchingByThreadKey: Record<string, AnnotationTarget>;
  /** Annotations the last Send or Watch prompt named, per thread. */
  lastSentIdsByThreadKey: Record<string, string[]>;
  setWatching: (threadKey: string, target: AnnotationTarget | null) => void;
  markSent: (threadKey: string, ids: ReadonlyArray<string>) => void;
}

export const useAnnotationWatchStore = create<AnnotationWatchState>()(
  persist(
    (set) => ({
      watchingByThreadKey: {},
      lastSentIdsByThreadKey: {},
      setWatching: (threadKey, target) =>
        set((state) => {
          const watchingByThreadKey = { ...state.watchingByThreadKey };
          if (target === null) delete watchingByThreadKey[threadKey];
          else
            watchingByThreadKey[threadKey] = {
              environmentId: target.environmentId,
              projectId: target.projectId,
            };
          return { watchingByThreadKey };
        }),
      markSent: (threadKey, ids) =>
        set((state) => ({
          lastSentIdsByThreadKey: { ...state.lastSentIdsByThreadKey, [threadKey]: [...ids] },
        })),
    }),
    {
      name: STORAGE_KEY,
      // Version 1 watched an annotator URL; that state cannot name a project, so drop it.
      version: 2,
      migrate: () => ({ watchingByThreadKey: {}, lastSentIdsByThreadKey: {} }),
      storage: createJSONStorage(() =>
        resolveStorage(typeof window !== "undefined" ? window.localStorage : undefined),
      ),
    },
  ),
);

// Extra windows toggle Watch too; the main window, which sends, picks the change up.
onOtherWindowStorageChange(STORAGE_KEY, () => {
  void useAnnotationWatchStore.persist.rehydrate();
});

export function useAnnotationWatch(threadKey: string): AnnotationTarget | null {
  return useAnnotationWatchStore((state) => state.watchingByThreadKey[threadKey] ?? null);
}
