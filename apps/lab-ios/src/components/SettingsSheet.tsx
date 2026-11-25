import { useId, useRef, useState } from "react";
import { settingsPages, type Choice, type SettingsPage } from "../data/settings";
import type { IconName } from "../icons.generated";
import {
  BUILT_IN_THEMES,
  getThemeColorsForAppearance,
} from "../../../../packages/shared/src/themePalettes";
import { nativeTheme, nativeThemeTokens } from "../nativeTheme";
import { GlassButton } from "./GlassHeader";
import { Icon } from "./Icon";
const settingsSections = [
  {
    title: "Orbit",
    rows: [
      ["Connections", "desktop"],
      ["Projects", "folder"],
    ],
  },
  {
    rows: [
      ["General", "settings"],
      ["Appearance", "paint"],
      ["Chat", "thread"],
      ["Voice", "microphone"],
    ],
  },
  {
    title: "Agents",
    rows: [
      ["Providers", "user-circle"],
      ["Threads", "threads"],
      ["Scheduled tasks", "clock"],
    ],
  },
  {
    title: "This iPhone",
    rows: [
      ["Client storage", "layers"],
      ["About", "info"],
    ],
  },
] satisfies { title?: string; rows: [SettingsPage, IconName][] }[];

export type PreviewPreferences = Record<string, string | boolean>;

export function SettingsSheet({
  close,
  offline,
  light,
  preferences,
  onChange,
}: {
  close: () => void;
  offline: boolean;
  light: boolean;
  preferences: PreviewPreferences;
  onChange: (key: string, value: string | boolean) => void;
}) {
  const [page, setPage] = useState<SettingsPage | null>(null);
  const sheet = useRef<HTMLDivElement>(null);
  const scrollPositions = useRef(new Map<string, number>());
  const id = useId();
  const pages = settingsPages(offline);
  const [picker, setPicker] = useState<Choice | null>(null);
  const theme = preferences["Appearance/Color theme"];
  const preset = BUILT_IN_THEMES.find((entry) => entry.id === String(theme).toLowerCase());
  const colors = preset && getThemeColorsForAppearance(preset, light ? "light" : "dark");
  const previewTheme = colors
    ? nativeThemeTokens(colors, light)
    : nativeTheme(
        theme === "Dark Mono"
          ? "dark-mono"
          : theme === "Dark Ocean"
            ? "dark-ocean"
            : light || theme === "Light"
              ? "light"
              : "dark-ocean",
      );
  const open = (next: SettingsPage | null, back = false, nextPicker: Choice | null = null) => {
    scrollPositions.current.set(
      picker ? page + "/" + picker.label : (page ?? "Settings"),
      sheet.current?.scrollTop ?? 0,
    );
    setPicker(nextPicker);
    setPage(next);
    requestAnimationFrame(() => {
      if (sheet.current)
        sheet.current.scrollTop = back ? (scrollPositions.current.get(next ?? "Settings") ?? 0) : 0;
    });
  };
  return (
    <div
      ref={sheet}
      className="ios-sheet ios-settings-sheet"
      role="dialog"
      aria-label={picker?.label ?? page ?? "Settings"}
    >
      <header>
        <GlassButton
          icon={page ? "chevron-left" : "close"}
          label={page ? "Back" : "Close settings"}
          onClick={() => (page ? open(picker ? page : null, true) : close())}
        />
        {picker?.label ?? page ?? "Settings"}
        <i />
      </header>
      {picker && page ? (
        <section aria-label={picker.label}>
          <p className="ios-picker-hint">{picker.hint}</p>
          <div className="ios-group">
            {picker.options.map((option) => (
              <label className="ios-option ios-choice-row" key={option}>
                <span>{option}</span>
                <input
                  type="radio"
                  name={id + page + picker.label}
                  aria-label={option}
                  checked={(preferences[page + "/" + picker.label] ?? picker.options[0]) === option}
                  onChange={() => onChange(page + "/" + picker.label, option)}
                />
              </label>
            ))}
          </div>
        </section>
      ) : page ? (
        pages[page].map((group) => (
          <section key={group.title} aria-label={group.title}>
            <h2 className="ios-group-title">{group.title}</h2>
            <div className="ios-group ios-settings-options">
              {page === "Appearance" && group.title === "Theme" && (
                <div
                  className="ios-theme-sample"
                  style={{
                    ...previewTheme,
                    background: "var(--color-screen)",
                    color: "var(--color-foreground)",
                  }}
                >
                  <span
                    style={{ background: "var(--ios-message)", color: "var(--ios-message-ink)" }}
                  >
                    What changed in this PR?
                  </span>
                  <span>The composer now supports image attachments.</span>
                </div>
              )}
              {group.rows.map((row) => {
                const key = page + "/" + row.label;
                const copy = (
                  <span className="ios-option-copy">
                    <span>{row.label}</span>
                    {row.hint && <small>{row.hint}</small>}
                  </span>
                );
                if (row.kind === "choice")
                  return (
                    <button
                      key={key}
                      className="ios-option ios-option-disclosure"
                      onClick={() => open(page, false, row)}
                    >
                      {copy}
                      <span className="ios-option-value">
                        {preferences[key] ?? row.options[0]}
                        <Icon name="chevron-right" size={14} />
                      </span>
                    </button>
                  );
                if (row.kind === "info")
                  return (
                    <div className="ios-option" key={key}>
                      {copy}
                      {row.value && <span className="ios-option-value">{row.value}</span>}
                    </div>
                  );
                return (
                  <label className="ios-option" key={key}>
                    {copy}
                    <input
                      type="checkbox"
                      role="switch"
                      aria-label={row.label}
                      checked={Boolean(preferences[key] ?? row.initial)}
                      onChange={(e) => onChange(key, e.target.checked)}
                    />
                  </label>
                );
              })}
            </div>
          </section>
        ))
      ) : (
        settingsSections.map(({ title, rows }) => (
          <section key={rows[0]![0]} aria-label={title}>
            {title && <h2 className="ios-group-title">{title}</h2>}
            <div className="ios-group">
              {rows.map(([label, icon]) => (
                <button key={label} onClick={() => open(label)}>
                  <Icon name={icon} size={22} />
                  <span className="ios-settings-label">{label}</span>
                  <Icon name="chevron-right" size={15} />
                </button>
              ))}
            </div>
          </section>
        ))
      )}
    </div>
  );
}
