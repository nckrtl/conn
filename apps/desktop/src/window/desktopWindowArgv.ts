export function parseDesktopWindowArgv(argv: ReadonlyArray<string>): {
  readonly additional: boolean;
  readonly workspace: string | null;
} {
  const additional = argv.includes("--t3code-window=additional");
  const workspaceArg = argv.find((arg) => arg.startsWith("--t3code-window-workspace="));
  if (workspaceArg === undefined) return { additional, workspace: null };
  try {
    return {
      additional,
      workspace: decodeURIComponent(workspaceArg.slice("--t3code-window-workspace=".length)),
    };
  } catch {
    return { additional, workspace: null };
  }
}
