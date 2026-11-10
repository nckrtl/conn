/**
 * Marks theme changes the user did not make. The profile sync shares only the user's own picks,
 * so a theme an environment pushes (`startDefaultThemeAdoption`) must not reach other devices.
 * `asDefaultThemeAdoption` wraps such a change and tells every registered tracker around it.
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
