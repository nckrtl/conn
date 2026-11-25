import { FileDiff } from "@pierre/diffs/react";
import { useMemo } from "react";
import {
  DIFF_SURFACE_THEME_UNSAFE_CSS,
  getRenderablePatch,
  resolveDiffThemeName,
} from "../../../web/src/lib/diffRendering";
import { PREFERRED_HIGHLIGHTER } from "../../../web/src/lib/syntaxHighlighting";
import type { PrFileChange } from "../data/pullRequests";

export default function PullRequestFileDiff({
  file,
  light,
}: {
  file: PrFileChange;
  light: boolean;
}) {
  const diff = useMemo(() => {
    // Hunk lengths describe the excerpt; the file's totals also include changes outside it.
    const oldLines = file.excerpt.filter((line) => !line.startsWith("+")).length;
    const newLines = file.excerpt.filter((line) => !line.startsWith("-")).length;
    const patch = [
      "diff --git a/" + file.path + " b/" + file.path,
      file.status === "New" ? "--- /dev/null" : "--- a/" + file.path,
      file.status === "Deleted" ? "+++ /dev/null" : "+++ b/" + file.path,
      "@@ -" +
        (oldLines ? 1 : 0) +
        "," +
        oldLines +
        " +" +
        (newLines ? 1 : 0) +
        "," +
        newLines +
        " @@",
      ...file.excerpt,
      "",
    ].join("\n");
    const parsed = getRenderablePatch(patch, "ios-pr");
    return parsed?.kind === "files" ? parsed.files[0] : undefined;
  }, [file]);
  const theme = light ? "light" : "dark";
  if (!diff) return <p>Diff unavailable.</p>;
  return (
    <div className="ios-file-patch" role="region" aria-label={"Diff for " + file.path}>
      <FileDiff
        fileDiff={diff}
        options={{
          diffStyle: "unified",
          lineDiffType: "none",
          overflow: "scroll",
          disableFileHeader: true,
          theme: resolveDiffThemeName(theme),
          themeType: theme,
          preferredHighlighter: PREFERRED_HIGHLIGHTER,
          unsafeCSS: DIFF_SURFACE_THEME_UNSAFE_CSS,
        }}
      />
    </div>
  );
}
