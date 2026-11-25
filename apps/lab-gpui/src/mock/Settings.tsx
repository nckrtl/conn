import { useRef, useLayoutEffect, useState } from "react";
import { Icon, Tool } from "./Icon";
import { themes } from "./themes";
import catalog from "./model-catalog.json";

const pages = {
  General: "filter",
  Appearance: "theme",
  Terminal: "terminal-window",
  Connections: "plug",
  Providers: "agent",
  Projects: "folder",
  "Scheduled tasks": "clock",
  Keyboard: "keyboard",
};
const rows: Record<string, string[][]> = {
  General: [
    ["Application", "Conn native desktop shell powered by Rust and GPUI.", "conn-gpui"],
    [
      "Interface typography",
      "13px sans UI scale with tabular numerals for metadata.",
      "13px / 20px",
    ],
  ],
  Terminal: [
    [
      "Font family",
      "A font installed on this Mac. Empty uses the theme's monospace font.",
      "JetBrains Mono",
    ],
    ["Font size", "8 to 20 pixels.", "14"],
    ["Font weight", "", "Normal"],
    ["Line height", "A multiple of the font size, 1 to 2.", "1.4"],
    ["Letter spacing", "Extra space after each character.", "0"],
    ["Cursor style", "", "Block"],
  ],
  Connections: [
    ["nick", "Local environment", "Connected"],
    ["Transport", "Typed conn-wire / conn-contract RPC over WebSocket.", "WebSocket"],
  ],
  Providers: Array.from(new Set(catalog.map((m) => m.provider))).map((p) => [
    p,
    "",
    catalog.filter((m) => m.provider === p).length + " models",
  ]),
  Projects: [
    ["conn", "~/apps/conn", ""],
    ["orbit", "~/apps/orbit", ""],
  ],
  "Scheduled tasks": [
    [
      "No scheduled tasks",
      "Create recurring agent runs on a fixed schedule, interval, one-shot timestamp, or incoming webhook.",
      "",
    ],
  ],
  Keyboard: [
    ["Command palette", "Search threads, projects, themes, and shell actions.", "⌘ K"],
    ["New thread", "Start composing a new thread in the current project.", "⌘ N"],
    ["Open settings", "Open the Settings modal from anywhere in the window.", "⌘ ,"],
    ["Toggle sidebar", "Show or hide the workspace rail and thread sidebar.", "⌘ B"],
    ["Toggle right panel", "Show or hide the Files, Diff, Terminal, and Browser panel.", "⌘ ⌥ B"],
    ["Dismiss modal or palette", "Close the active overlay and return focus to the shell.", "Esc"],
  ],
};
export function Settings({
  id,
  onTheme,
  onClose,
  opaque,
  onOpaque,
  context,
  onContext,
}: {
  id: string;
  onTheme: (id: string) => void;
  onClose: () => void;
  opaque: boolean;
  onOpaque: () => void;
  context: boolean;
  onContext: () => void;
}) {
  const [page, setPage] = useState("Appearance");
  const [query, setQuery] = useState("");
  const dialog = useRef<HTMLDialogElement>(null);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- Use the browser modal focus trap and restore focus to the rail on close.
  useLayoutEffect(() => {
    const d = dialog.current!;
    d.showModal();
    return () => d.close();
  }, []);
  const q = query.trim().toLowerCase();
  return (
    <dialog
      className="settings-modal"
      ref={dialog}
      onCancel={onClose}
      onClick={(e) => {
        if (e.target === e.currentTarget) {
          const r = e.currentTarget.getBoundingClientRect();
          if (
            e.clientX < r.left ||
            e.clientX > r.right ||
            e.clientY < r.top ||
            e.clientY > r.bottom
          )
            onClose();
        }
      }}
    >
      <header>
        Settings <span>/</span> <span>{page}</span>
        <i className="spacer" />
        <Tool label="Close settings" icon="close" onClick={onClose} />
      </header>
      <div className="settings-body">
        <nav>
          <label className="search">
            <Icon name="search" />
            <input
              aria-label="Search settings"
              placeholder="Search settings"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
            />
          </label>
          {Object.entries(pages).map(([label, icon]) => (
            <button
              key={label}
              aria-pressed={!q && label === page}
              onClick={() => {
                setQuery("");
                setPage(label);
              }}
            >
              <Icon name={icon} />
              {label}
            </button>
          ))}
        </nav>
        <div className="settings-content">
          <div>
            {(page === "Appearance" || q) &&
              ["dark", "light"].map((mode) => {
                const items = themes.filter(
                  (t) =>
                    t.appearance === mode &&
                    (!q || (t.name + " theme appearance color").toLowerCase().includes(q)),
                );
                return (
                  items.length > 0 && (
                    <section key={mode}>
                      <h3>{mode === "dark" ? "Dark" : "Light"} themes</h3>
                      <div className="settings-group">
                        {items.map((t) => (
                          <button
                            className="theme-row"
                            key={t.id}
                            aria-label={t.name}
                            aria-pressed={t.id === id}
                            onClick={() => onTheme(t.id)}
                          >
                            <i className="swatch" style={{ background: t.colors.canvas }}>
                              {(["sidebar", "accent", "secondary"] as const).map((role) => (
                                <b key={role} style={{ background: t.colors[role] }} />
                              ))}
                            </i>
                            {t.name}
                            <i className="spacer" />
                            {t.id === id ? (
                              <>
                                Active
                                <Icon name="check" />
                              </>
                            ) : (
                              <small>{t.id}</small>
                            )}
                          </button>
                        ))}
                      </div>
                    </section>
                  )
                );
              })}
            {page === "Appearance" && !q && (
              <section>
                <h3>Window</h3>
                <div className="settings-group">
                  {[
                    [
                      "Reduce transparency",
                      "Use opaque card surfaces instead of translucent frosted fills.",
                      opaque,
                      onOpaque,
                    ],
                    [
                      "Keep composer context visible",
                      "Keep branch and worktree controls below the composer after a thread starts.",
                      context,
                      onContext,
                    ],
                  ].map(([title, desc, on, action]) => (
                    <div key={String(title)} className="setting-row">
                      <div>
                        {String(title)}
                        <small>{String(desc)}</small>
                      </div>
                      <button
                        role="switch"
                        aria-label={String(title)}
                        aria-checked={!!on}
                        onClick={action as () => void}
                        className="toggle-switch"
                      />
                    </div>
                  ))}
                </div>
              </section>
            )}
            {Object.entries(rows).map(([title, list]) => {
              const matched = list.filter((r) =>
                q ? r.join(" ").toLowerCase().includes(q) : title === page,
              );
              return (
                matched.length > 0 && (
                  <section key={title}>
                    <h3>{title}</h3>
                    <div className="settings-group">
                      {matched.map(([label, desc, value]) => (
                        <div className="setting-row" key={label}>
                          <div>
                            {label}
                            <small>{desc}</small>
                          </div>
                          <small>{value}</small>
                        </div>
                      ))}
                    </div>
                  </section>
                )
              );
            })}
          </div>
        </div>
      </div>
    </dialog>
  );
}
