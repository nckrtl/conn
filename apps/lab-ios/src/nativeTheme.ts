import type { CSSProperties } from "react";
import ocean from "../../../crates/conn-theme/themes/dark-ocean.json";
import mono from "../../../crates/conn-theme/themes/dark-mono.json";
import {
  T3_CODE_LIGHT_THEME_COLORS,
  type ThemeColors,
} from "../../../packages/shared/src/themePalettes";
export type PhoneTheme = "dark-ocean" | "dark-mono" | "light";
// ConnTheme.swift resolves these roles through conn-ffi's themeTokens.
export function nativeTheme(choice: PhoneTheme): CSSProperties {
  const c =
    choice === "light"
      ? T3_CODE_LIGHT_THEME_COLORS
      : choice === "dark-mono"
        ? mono.colors
        : ocean.colors;
  return {
    ...nativeThemeTokens(c, choice === "light"),
    "--color-screen": "var(--thread-page)",
    "--color-thread-canvas": "var(--thread-page)",
    "--color-sheet": "var(--thread-page)",
    "--ios-settings-group":
      choice === "light"
        ? "color-mix(in srgb, var(--color-screen) 95%, var(--color-foreground))"
        : "var(--thread-card-surface)",
  } as CSSProperties;
}

export function nativeThemeTokens(
  c: ThemeColors | typeof ocean.colors | typeof mono.colors,
  light: boolean,
): CSSProperties {
  return {
    "--color-screen": c.canvas,
    "--color-thread-canvas": c.canvas,
    "--color-sheet": c.canvas,
    "--color-sheet-solid": c.surfaceOverlay,
    "--color-card": c.surface,
    "--color-grouped-card": c.surface,
    "--color-foreground": c.text,
    "--color-foreground-muted": c.mutedForeground,
    "--color-foreground-tertiary": c.mutedForeground,
    "--color-border": c.border,
    "--color-composer-border": c.border,
    "--color-primary": c.messageAction,
    "--color-primary-foreground": c.messageActionForeground,
    "--color-placeholder": c.placeholder,
    "--color-glass-surface": "color-mix(in srgb," + c.surface + " 78%, transparent)",
    "--color-composer-surface": "var(--color-glass-surface)",
    "--ios-secondary": c.secondary,
    "--ios-accent-foreground": c.accentSurfaceForeground,
    "--ios-message": c.messageSurface,
    "--ios-message-ink": c.messageForeground,
    "--color-card-face": c.surface,
    "--color-card-face-border": c.border,
    "--color-card-face-edge": c.border,
    "--color-md-body": c.text,
    "--color-md-strong": c.text,
    "--color-md-code-text": c.codeForeground,
    "--ios-code": c.codeBackground,
    // GPUI chat/color.rs uses conn-theme's derived semantic and shell colors.
    "--thread-info": "oklch(0.623 0.214 259.815)",
    "--thread-success": "oklch(0.696 0.17 162.48)",
    "--thread-warning": c.warning,
    "--thread-destructive": c.error,
    "--thread-divider": `color-mix(in oklab, ${c.sidebar} ${light ? 90 : 89}%, ${c.text})`,
    "--thread-page": light ? `color-mix(in oklab, ${c.sidebar} 40%, ${c.canvas})` : c.sidebar,
    "--thread-card-surface": light
      ? "var(--thread-page)"
      : `color-mix(in srgb, ${c.text} 5.6%, var(--thread-page))`,
    "--thread-control": light ? c.sidebar : `color-mix(in oklab, ${c.sidebar} 91%, ${c.text})`,
    "--thread-inner-border": light ? "rgb(0 0 0 / 8%)" : "rgb(255 255 255 / 8%)",
  } as CSSProperties;
}
