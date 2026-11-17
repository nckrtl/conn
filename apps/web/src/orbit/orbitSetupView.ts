export interface OrbitReadyView {
  readonly instanceName: string;
  readonly nodeName: string;
  readonly url: string | null;
  /** The one assistant-style line Conn renders; never sent to the agent. */
  readonly readyLine: string;
  /** The model the agent uses instead of the composer's, or null. */
  readonly modelFallbackLine: string | null;
  /** From the create's result: the branch checked out, and the base (null in mode existing). */
  readonly branch: string | null;
  readonly baseBranch: string | null;
  /** Shown only when the checked-out code is not the default branch. */
  readonly dependenciesLine: string | null;
}

export function orbitReadyLine(url: string | null): string {
  return url === null
    ? "Your Instance is ready."
    : `Your Instance is ready. You can preview it at ${url} while I work on your request.`;
}
