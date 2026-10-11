import type { ProjectIconColor, ProjectIconOverride } from "@t3tools/contracts";
import { deriveProjectIdentity } from "@t3tools/shared/projectIdentity";

import { themeColorWithAlpha } from "./mobileTheme";

export type ProjectMonogramGlyph = {
  readonly kind: "monogram";
  readonly text: string;
  readonly color: ProjectIconColor;
};

export type ProjectIconGlyph =
  | { readonly kind: "emoji"; readonly emoji: string }
  | ProjectMonogramGlyph;

/**
 * Visible glyph count for sizing monogram text. Hermes has no Intl.Segmenter, so combining
 * marks are folded into their base character instead of full grapheme segmentation.
 */
export function countGlyphs(text: string): number {
  return Array.from(text.replace(/\p{M}/gu, "")).length;
}

/**
 * Picks what mobile draws for an assigned project icon, with the same precedence as the
 * web `ProjectFavicon`. Mobile does not bundle the Lucide set (icons are imported one by
 * one), so a Lucide override keeps its color and shows the title monogram instead.
 * Returns null when the project has no override.
 */
export function resolveProjectIconGlyph(
  projectIcon: ProjectIconOverride | null | undefined,
  projectTitle: string,
): ProjectIconGlyph | null {
  switch (projectIcon?.kind) {
    case "emoji":
      return { kind: "emoji", emoji: projectIcon.emoji };
    case "monogram":
      return { kind: "monogram", text: projectIcon.text, color: projectIcon.color };
    case "lucide":
      return {
        kind: "monogram",
        text: deriveProjectIdentity(projectTitle).monogram,
        color: projectIcon.color,
      };
    case undefined:
      return null;
  }
}

/**
 * The generated monogram shown when a project has no override and no favicon. Null only for
 * a blank title, which keeps the folder, matching web.
 */
export function resolveProjectFallbackGlyph(projectTitle: string): ProjectMonogramGlyph | null {
  if (projectTitle.trim().length === 0) return null;
  const identity = deriveProjectIdentity(projectTitle);
  return { kind: "monogram", text: identity.monogram, color: identity.color };
}

// Tailwind 600 on light themes and 400 on dark themes, the shades web uses for
// `text-<color>-600 dark:text-<color>-400`.
const PROJECT_ICON_COLORS: Record<
  ProjectIconColor,
  { readonly light: string; readonly dark: string }
> = {
  gray: { light: "#4b5563", dark: "#9ca3af" },
  red: { light: "#dc2626", dark: "#f87171" },
  orange: { light: "#ea580c", dark: "#fb923c" },
  amber: { light: "#d97706", dark: "#fbbf24" },
  yellow: { light: "#ca8a04", dark: "#facc15" },
  lime: { light: "#65a30d", dark: "#a3e635" },
  green: { light: "#16a34a", dark: "#4ade80" },
  emerald: { light: "#059669", dark: "#34d399" },
  teal: { light: "#0d9488", dark: "#2dd4bf" },
  cyan: { light: "#0891b2", dark: "#22d3ee" },
  sky: { light: "#0284c7", dark: "#38bdf8" },
  blue: { light: "#2563eb", dark: "#60a5fa" },
  indigo: { light: "#4f46e5", dark: "#818cf8" },
  violet: { light: "#7c3aed", dark: "#a78bfa" },
  purple: { light: "#9333ea", dark: "#c084fc" },
  fuchsia: { light: "#c026d3", dark: "#e879f9" },
  pink: { light: "#db2777", dark: "#f472b6" },
  rose: { light: "#e11d48", dark: "#fb7185" },
};

/** Text color and the 14% tint web mixes behind it, for the current appearance. */
export function projectIconColors(color: ProjectIconColor, appearance: "light" | "dark") {
  const text = PROJECT_ICON_COLORS[color][appearance];
  return { text, background: themeColorWithAlpha(text, 0.14) };
}
