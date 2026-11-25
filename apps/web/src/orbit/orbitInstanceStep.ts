import type { OrbitDraftTarget } from "./orbitDraft";

/**
 * Conn: reopens the palette's Instance step for an Orbit Project. The palette registers its
 * opener when it has that step; until then a request does nothing.
 */
type OrbitInstanceStepOpener = (target: OrbitDraftTarget) => void;

let opener: OrbitInstanceStepOpener | null = null;

export function registerOrbitInstanceStepOpener(next: OrbitInstanceStepOpener): () => void {
  opener = next;
  return () => {
    if (opener === next) opener = null;
  };
}

/** Opens the step for the draft's Project, with the draft's new Instance name filled in. */
export function openOrbitInstanceStep(target: OrbitDraftTarget): boolean {
  if (opener === null) return false;
  opener(target);
  return true;
}
