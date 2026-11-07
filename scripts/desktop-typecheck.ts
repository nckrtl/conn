export const DESKTOP_TYPECHECK_PACKAGE = "@t3tools/desktop";

export const desktopTypecheckVpArgs = [
  "run",
  "--no-cache",
  "--filter",
  DESKTOP_TYPECHECK_PACKAGE,
  "typecheck",
] as const;

export const DESKTOP_TYPECHECK_LABEL = "vp run --no-cache --filter @t3tools/desktop typecheck";

// Web-only tsc cannot see missing window or preview members that IPC still calls.
export function withDesktopTypecheck(packages: ReadonlyArray<string>): string[] {
  return packages.includes(DESKTOP_TYPECHECK_PACKAGE)
    ? [...packages]
    : [...packages, DESKTOP_TYPECHECK_PACKAGE];
}
