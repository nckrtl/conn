/**
 * Conn: reopens the palette's Instance step for an Orbit Project. The palette registers its
 * opener when it has that step; until then a request does nothing.
 */
type OrbitInstanceStepOpener = (orbitProjectId: number) => void;

let opener: OrbitInstanceStepOpener | null = null;

export function registerOrbitInstanceStepOpener(next: OrbitInstanceStepOpener): () => void {
  opener = next;
  return () => {
    if (opener === next) opener = null;
  };
}

export function openOrbitInstanceStep(orbitProjectId: number): boolean {
  if (opener === null) return false;
  opener(orbitProjectId);
  return true;
}
