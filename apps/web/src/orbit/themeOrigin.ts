/**
 * Marks theme changes the user did not make. The profile sync shares the user's own picks only,
 * so a theme an environment pushes (`t3 theme set`, applied by `startDefaultThemeAdoption`) must
 * not reach the other devices.
 *
 * `asDefaultThemeAdoption` wraps the change; every tracker registered here is told before and
 * after it, and the profile sync uses that to treat the resulting appearance as not edited.
 */

type BeginTracking = () => () => void;

const trackers = new Set<BeginTracking>();

/** The profile sync registers here. Returns the function that stops tracking. */
export function trackNonUserThemeChanges(begin: BeginTracking): () => void {
  trackers.add(begin);
  return () => {
    trackers.delete(begin);
  };
}

/** Runs a theme change that comes from the environment's default theme, not from the user. */
export function asDefaultThemeAdoption<T>(change: () => T): T {
  const finishers = [...trackers].map((begin) => begin());
  try {
    return change();
  } finally {
    for (const finish of finishers) finish();
  }
}
