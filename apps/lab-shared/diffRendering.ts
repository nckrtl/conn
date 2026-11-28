// Patch parsing and diff surface styles, from apps/web/src/lib/diffRendering.ts and
// syntaxHighlighting.ts, with English strings in place of the web app's translations.
import { parsePatchFiles, setCustomExtension, type FileDiffMetadata, type HighlighterTypes } from "@pierre/diffs";

import { READABLE_LIGHT_THEME_NAME } from "./readableSyntaxTheme";

// Highlights has no lexer for these dialects, so they use their base language's. The default .s
// mapping is riscv, which the Highlights backend does not support.
setCustomExtension("luau", "lua");
setCustomExtension("xsl", "xml");
setCustomExtension("xslt", "xml");
for (const extension of ["asm", "ASM", "s", "S", "nasm", "NASM"]) {
  setCustomExtension(extension, "asm");
}

/** Only one highlighter type can be active per thread, so every creation site passes this. */
export const PREFERRED_HIGHLIGHTER: HighlighterTypes = "highlights";

// Light mode uses a darker pierre-light so syntax stays readable on every code surface.
const DIFF_THEME_NAMES = {
  light: READABLE_LIGHT_THEME_NAME,
  dark: "pierre-dark",
} as const;

export function resolveDiffThemeName(theme: "light" | "dark") {
  return DIFF_THEME_NAMES[theme];
}

const FNV_OFFSET_BASIS_32 = 0x811c9dc5;
const FNV_PRIME_32 = 0x01000193;
const SECONDARY_HASH_SEED = 0x9e3779b9;
const SECONDARY_HASH_MULTIPLIER = 0x85ebca6b;

function fnv1a32(input: string, seed = FNV_OFFSET_BASIS_32, multiplier = FNV_PRIME_32): number {
  let hash = seed >>> 0;
  for (let index = 0; index < input.length; index += 1) {
    hash ^= input.charCodeAt(index);
    hash = Math.imul(hash, multiplier) >>> 0;
  }
  return hash >>> 0;
}

function buildPatchCacheKey(patch: string, scope: string): string {
  const primary = fnv1a32(patch, FNV_OFFSET_BASIS_32, FNV_PRIME_32).toString(36);
  const secondary = fnv1a32(patch, SECONDARY_HASH_SEED, SECONDARY_HASH_MULTIPLIER).toString(36);
  return `${scope}:${patch.length}:${primary}:${secondary}`;
}

export type RenderablePatch =
  | { kind: "files"; files: FileDiffMetadata[]; sourceFiles: FileDiffMetadata[] }
  | { kind: "raw"; text: string; reason: string };

export function getRenderablePatch(
  patch: string | undefined,
  cacheScope = "diff-panel",
): RenderablePatch | null {
  if (!patch?.trim()) return null;
  try {
    const parsedPatches = parsePatchFiles(patch, {
      cacheKeyPrefix: buildPatchCacheKey(patch, cacheScope),
    });
    const files = parsedPatches.flatMap((parsedPatch) => parsedPatch.files);
    if (files.length > 0) return { kind: "files", files, sourceFiles: files };
    return { kind: "raw", text: patch, reason: "Unsupported diff format. Showing raw patch." };
  } catch {
    return { kind: "raw", text: patch, reason: "Failed to parse patch. Showing raw patch." };
  }
}

export const DIFF_SURFACE_THEME_UNSAFE_CSS = `
[data-diffs-header],
[data-diff],
[data-file],
[data-error-wrapper],
[data-virtualizer-buffer] {
  --diffs-header-font-family: var(--font-sans) !important;
  --diffs-font-family: var(--font-mono) !important;
  --diffs-bg: var(--code-background) !important;
  --diffs-light-bg: var(--code-background) !important;
  --diffs-dark-bg: var(--code-background) !important;
  --diffs-token-light-bg: transparent;
  --diffs-token-dark-bg: transparent;

  /* Gutter, context, and row tints all derive from the code surface the diff
     body sits on. Mixing from the canvas leaves the gutter looking unthemed
     when a palette separates the two. */
  --diffs-bg-context-override: color-mix(in srgb, var(--code-background) 97%, var(--code-foreground));
  --diffs-bg-hover-override: color-mix(in srgb, var(--code-background) 94%, var(--code-foreground));
  --diffs-bg-separator-override: color-mix(
    in srgb,
    var(--code-background) 95%,
    var(--code-foreground)
  );
  --diffs-bg-buffer-override: color-mix(in srgb, var(--code-background) 90%, var(--code-foreground));

  --diffs-bg-addition-override: light-dark(
    color-mix(in srgb, var(--code-background) calc(50% - var(--appearance-contrast-boost, 0%) / 4), var(--diff-addition)),
    color-mix(in srgb, var(--code-background) calc(70% - var(--appearance-contrast-boost, 0%) / 4), var(--diff-addition))
  );
  --diffs-bg-addition-number-override: light-dark(
    color-mix(in srgb, var(--code-background) calc(35% - var(--appearance-contrast-boost, 0%) / 4), var(--diff-addition)),
    color-mix(in srgb, var(--code-background) calc(60% - var(--appearance-contrast-boost, 0%) / 4), var(--diff-addition))
  );
  --diffs-bg-addition-hover-override: color-mix(in srgb, var(--code-background) 85%, var(--diff-addition));
  /* Pierre resolves emphasis on the host, before the diff's overrides can inherit. */
  /* Light emphasis stays above t3-light's readable syntax luminance floor. */
  --diffs-bg-addition-emphasis: light-dark(
    rgb(from var(--diffs-addition-base) r g b / 15%),
    rgb(from var(--diffs-addition-base) r g b / calc(20% + var(--appearance-contrast-boost, 0%) / 4))
  );

  --diffs-bg-deletion-override: light-dark(
    color-mix(in srgb, var(--code-background) calc(50% - var(--appearance-contrast-boost, 0%) / 4), var(--diff-deletion)),
    color-mix(in srgb, var(--code-background) calc(70% - var(--appearance-contrast-boost, 0%) / 4), var(--diff-deletion))
  );
  --diffs-bg-deletion-number-override: light-dark(
    color-mix(in srgb, var(--code-background) calc(35% - var(--appearance-contrast-boost, 0%) / 4), var(--diff-deletion)),
    color-mix(in srgb, var(--code-background) calc(60% - var(--appearance-contrast-boost, 0%) / 4), var(--diff-deletion))
  );
  --diffs-bg-deletion-hover-override: color-mix(
    in srgb,
    var(--code-background) 85%,
    var(--diff-deletion)
  );
  --diffs-bg-deletion-emphasis: light-dark(
    rgb(from var(--diffs-deletion-base) r g b / 15%),
    rgb(from var(--diffs-deletion-base) r g b / calc(20% + var(--appearance-contrast-boost, 0%) / 4))
  );

  background-color: var(--diffs-bg) !important;
  color: var(--code-foreground) !important;
}

/* File-header line counts match the toolbar stat (13px). */
[data-diffs-header] [data-metadata],
[data-diffs-header] [data-additions-count],
[data-diffs-header] [data-deletions-count] {
  font-size: 13px;
}

/* The library's change-icon colors are tuned for dark canvases; light mode takes the app's darker tokens. */
[data-change-icon="new"] {
  color: var(
    --diff-added-icon,
    light-dark(var(--diff-addition-foreground), var(--diffs-addition-base))
  ) !important;
}
[data-change-icon="deleted"] {
  color: light-dark(var(--diff-deletion-foreground), var(--diffs-deletion-base)) !important;
}
/* The page sets --diff-modified-icon to a muted T3 blue, so the common case stays quiet. */
[data-change-icon="change"],
[data-change-icon="rename-pure"],
[data-change-icon="rename-changed"] {
  color: var(
    --diff-modified-icon,
    light-dark(var(--info-foreground), var(--diffs-modified-base))
  ) !important;
}
`;
