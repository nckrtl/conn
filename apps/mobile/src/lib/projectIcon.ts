import { isScratchProject } from "@t3tools/client-runtime/state/projects";
import type { ProjectIconColor, ProjectIconOverride } from "@t3tools/contracts";
import { isProjectFaviconFallbackUrl } from "@t3tools/shared/projectFavicon";
import { deriveProjectIdentity } from "@t3tools/shared/projectIdentity";

import type { AppSymbolName } from "../components/ui/AppSymbol";
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
 * Hermes has no Intl.Segmenter, so combining marks are folded into their base
 * character instead of full grapheme segmentation.
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

/** Upstream's name for the generated monogram; Conn derives it with `deriveProjectIdentity`. */
export const projectAutoMonogram = resolveProjectFallbackGlyph;

const SYMBOL_BY_LUCIDE_NAME: Partial<Record<string, AppSymbolName>> = {
  "message-square-dashed": "text.bubble",
};

export function resolveProjectIconSymbol(
  projectIcon: ProjectIconOverride | null | undefined,
): { readonly name: AppSymbolName; readonly color: ProjectIconColor } | null {
  if (projectIcon?.kind !== "lucide") return null;
  const name = SYMBOL_BY_LUCIDE_NAME[projectIcon.name];
  return name ? { name, color: projectIcon.color } : null;
}

export type ProjectChipIcon = { readonly kind: "favicon"; readonly uri: string } | ProjectIconGlyph;

export function resolveProjectChipIcon(
  project: {
    readonly title: string;
    readonly workspaceRoot: string;
    readonly projectIcon?: ProjectIconOverride | null;
  } | null,
  scratchWorkspaceRoot: string | null | undefined,
  faviconUrl: () => string | null,
): ProjectChipIcon | null {
  if (!project || isScratchProject(project, scratchWorkspaceRoot)) return null;
  const glyph = resolveProjectIconGlyph(project.projectIcon, project.title);
  if (glyph) return glyph;
  const url = faviconUrl();
  if (url && !isProjectFaviconFallbackUrl(url)) return { kind: "favicon", uri: url };
  return projectAutoMonogram(project.title);
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

// Class names for the chip icon rasterizer (upstream's `ProjectChipIconImages`).
const PROJECT_ICON_COLOR_CLASSES: Record<
  ProjectIconColor,
  { readonly text: string; readonly tint: string; readonly background: string }
> = {
  gray: { text: "text-gray-500", tint: "accent-gray-500", background: "bg-gray-500/15" },
  red: { text: "text-red-500", tint: "accent-red-500", background: "bg-red-500/15" },
  orange: { text: "text-orange-500", tint: "accent-orange-500", background: "bg-orange-500/15" },
  amber: { text: "text-amber-500", tint: "accent-amber-500", background: "bg-amber-500/15" },
  yellow: { text: "text-yellow-500", tint: "accent-yellow-500", background: "bg-yellow-500/15" },
  lime: { text: "text-lime-500", tint: "accent-lime-500", background: "bg-lime-500/15" },
  green: { text: "text-green-500", tint: "accent-green-500", background: "bg-green-500/15" },
  emerald: {
    text: "text-emerald-500",
    tint: "accent-emerald-500",
    background: "bg-emerald-500/15",
  },
  teal: { text: "text-teal-500", tint: "accent-teal-500", background: "bg-teal-500/15" },
  cyan: { text: "text-cyan-500", tint: "accent-cyan-500", background: "bg-cyan-500/15" },
  sky: { text: "text-sky-500", tint: "accent-sky-500", background: "bg-sky-500/15" },
  blue: { text: "text-blue-500", tint: "accent-blue-500", background: "bg-blue-500/15" },
  indigo: { text: "text-indigo-500", tint: "accent-indigo-500", background: "bg-indigo-500/15" },
  violet: { text: "text-violet-500", tint: "accent-violet-500", background: "bg-violet-500/15" },
  purple: { text: "text-purple-500", tint: "accent-purple-500", background: "bg-purple-500/15" },
  fuchsia: {
    text: "text-fuchsia-500",
    tint: "accent-fuchsia-500",
    background: "bg-fuchsia-500/15",
  },
  pink: { text: "text-pink-500", tint: "accent-pink-500", background: "bg-pink-500/15" },
  rose: { text: "text-rose-500", tint: "accent-rose-500", background: "bg-rose-500/15" },
};

export function projectIconColorClassNames(color: ProjectIconColor) {
  return PROJECT_ICON_COLOR_CLASSES[color];
}
