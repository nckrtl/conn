/** Splits an absolute posix or Windows path into its root and cleaned segments, or null. */
function splitAbsolute(path: string): { drive: string; segments: string[] } | null {
  const normalized = path.replaceAll("\\", "/");
  const match = /^([A-Za-z]:)?\/(.*)$/.exec(normalized);
  if (!match) return null;
  const segments: string[] = [];
  for (const segment of (match[2] ?? "").split("/")) {
    if (segment === "" || segment === ".") continue;
    if (segment === "..") segments.pop();
    else segments.push(segment);
  }
  return { drive: (match[1] ?? "").toLowerCase(), segments };
}

/**
 * Whether an editor target such as `/app/Models/User.php:12` names a file inside
 * `projectRoot`. Used for paths that come from a web page (the Laravel Toolbar), which must
 * not open files elsewhere on the machine. Relative paths are refused. Symlinks are not
 * resolved here.
 */
export function isPathInsideProject(target: string, projectRoot: string): boolean {
  const root = splitAbsolute(projectRoot.trim());
  const file = splitAbsolute(target.trim().replace(/(?::\d+){1,2}$/, ""));
  if (!root || !file || root.drive !== file.drive) return false;
  const caseInsensitive = root.drive !== "";
  const same = (a: string, b: string) =>
    caseInsensitive ? a.toLowerCase() === b.toLowerCase() : a === b;
  return (
    file.segments.length > root.segments.length &&
    root.segments.every((segment, index) => same(segment, file.segments[index] ?? ""))
  );
}
