import darkOcean from "../../../../crates/conn-theme/themes/dark-ocean.json";
import darkMono from "../../../../crates/conn-theme/themes/dark-mono.json";
import {
  BUILT_IN_THEMES,
  T3_CODE_LIGHT_THEME_COLORS,
  T3_CODE_DARK_THEME_COLORS,
} from "../../../../packages/shared/src/themePalettes";
export const themes = [
  { id: "dark-mono", ...darkMono },
  { id: "dark-ocean", ...darkOcean },
  {
    id: "t3-code-light",
    name: "T3 Code Light",
    appearance: "light",
    colors: T3_CODE_LIGHT_THEME_COLORS,
  },
  {
    id: "t3-code-dark",
    name: "T3 Code Dark",
    appearance: "dark",
    colors: T3_CODE_DARK_THEME_COLORS,
  },
  ...BUILT_IN_THEMES.flatMap((t) => [
    { id: t.id, name: t.label, appearance: t.appearance, colors: t.colors },
    ...(t.variants?.dark
      ? [
          {
            id: t.id + "-dark",
            name: t.label + " Dark",
            appearance: "dark",
            colors: t.variants.dark,
          },
        ]
      : []),
  ]),
];
export function currentTheme() {
  const id = new URLSearchParams(location.search).get("theme");
  if (id === "light" || (id === "system" && matchMedia("(prefers-color-scheme: light)").matches))
    return themes[2]!;
  return themes.find((t) => t.id === id) ?? themes[1]!;
}
