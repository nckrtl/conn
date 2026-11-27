// The queued-message tray above the composer (GPUI `chat/queue_tray.rs`). Rows are fixture
// messages; Steer, remove, edit and the moves change only the page.
import { useEffect, useRef, useState } from "react";
import { Icon } from "./Icon";
import "./QueueTray.css";

export interface QueuedMessage {
  id: string;
  text: string;
}
export interface PendingSend {
  id: string;
  text: string;
  /** "Sending…" on a live connection, "Waiting for connection" while the server is away. */
  status: "Sending…" | "Waiting for connection";
}
/** A forced hover for screenshots: a row (1-based) and, optionally, one of its buttons. */
export interface ForcedHover {
  row: number;
  button?: "steer" | "remove" | "more" | undefined;
  menu?: boolean;
}

// The texts GPUI's queue screenshots use (`left_align_shots::queued_thread`).
export const QUEUED_FIXTURE = [
  "After that, also run clippy with warnings denied.",
  "Then open a PR with screenshots.",
  "Check that the light theme shows the tray clearly, with the same width as the composer and a tucked bottom edge, and tell me what you see",
  "Rename the helper so it says what it does",
  "Add a test for the empty queue",
  "Last one: delete the scratch files",
];

/** One folded line: whitespace collapses, at most 300 characters (`preview_text`). */
function preview(text: string) {
  return text.split(/\s+/).filter(Boolean).join(" ").slice(0, 300) || "Queued message";
}

/** The 12px turning arc of a pending send (`spinner::TurningArc`): 75% sweep, one turn in 0.9s. */
export function TurningArc() {
  const radius = 4.5;
  const sweep = 0.75 * 2 * Math.PI * radius;
  return (
    <svg className="turning-arc" viewBox="0 0 12 12" aria-hidden="true">
      <circle
        cx="6"
        cy="6"
        r={radius}
        fill="none"
        stroke="currentColor"
        strokeWidth="1.6"
        strokeLinecap="round"
        strokeDasharray={`${sweep} ${2 * Math.PI * radius}`}
      />
    </svg>
  );
}

export function QueueTray({
  rows,
  pending = [],
  forced,
  editing,
  onSteer,
  onRemove,
  onMove,
  onEdit,
}: {
  rows: QueuedMessage[];
  pending?: PendingSend[];
  forced?: ForcedHover | undefined;
  editing?: string | undefined;
  onSteer: (id: string) => void;
  onRemove: (id: string) => void;
  onMove: (id: string, step: -1 | 1) => void;
  onEdit: (id: string) => void;
}) {
  const [menu, setMenu] = useState<{ id: string; x: number; y: number } | null>(null);
  const tray = useRef<HTMLDivElement>(null);
  const forcedMenu = forced?.menu ? rows[forced.row - 1]?.id : undefined;
  const openMenu = menu?.id ?? forcedMenu;
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- Close the menu on an outside press, as the native popover does.
  useEffect(() => {
    if (!menu) return;
    const close = (event: PointerEvent) => {
      if (!(event.target instanceof Element) || !event.target.closest(".queue-menu")) setMenu(null);
    };
    document.addEventListener("pointerdown", close, true);
    return () => document.removeEventListener("pointerdown", close, true);
  }, [menu]);
  if (!rows.length && !pending.length) return null;
  const total = rows.length;
  return (
    <div ref={tray} className="queue-anchor">
      <div className="queue-tray" role="group" aria-label="Queued messages">
        <div className="queue-rows">
          {rows.map((row, index) => {
            const hovered = forced?.row === index + 1;
            const button = hovered ? forced?.button : undefined;
            return (
              <div key={row.id} className="queue-band">
                {index > 0 && <i className="queue-divider" aria-hidden="true" />}
                <div
                  className="queue-row"
                  role="group"
                  aria-label={`Queued message ${index + 1} of ${total}: ${preview(row.text)}`}
                  data-hovered={hovered || undefined}
                  data-editing={editing === row.id || undefined}
                >
                  <Icon name="reply-indent" />
                  <span className="queue-text">{preview(row.text)}</span>
                  {editing === row.id ? (
                    <span className="queue-actions">
                      <span className="queue-editing">Editing in the composer</span>
                      <button type="button" className="queue-cancel" onClick={() => onEdit("")}>
                        Cancel
                      </button>
                    </span>
                  ) : (
                    <span className="queue-actions">
                      <button
                        type="button"
                        className="queue-button"
                        aria-label="Steer"
                        data-tip="Send into the current turn"
                        data-hovered={button === "steer" || undefined}
                        onClick={() => onSteer(row.id)}
                      >
                        <Icon name="arrow-up" />
                      </button>
                      <button
                        type="button"
                        className="queue-button"
                        aria-label="Remove queued message"
                        data-tip="Remove from queue"
                        data-hovered={button === "remove" || undefined}
                        onClick={() => onRemove(row.id)}
                      >
                        <Icon name="delete" />
                      </button>
                      <button
                        type="button"
                        className="queue-button"
                        aria-label="More actions for queued message"
                        aria-haspopup="menu"
                        aria-expanded={openMenu === row.id}
                        data-tip="More"
                        data-hovered={button === "more" || openMenu === row.id || undefined}
                        onPointerDown={(event) => {
                          event.stopPropagation();
                          const box = tray.current!.getBoundingClientRect();
                          setMenu(
                            menu?.id === row.id
                              ? null
                              : {
                                  id: row.id,
                                  x: event.clientX - box.left,
                                  y: event.clientY - box.top,
                                },
                          );
                        }}
                      >
                        <Icon name="more-horizontal" />
                      </button>
                    </span>
                  )}
                </div>
              </div>
            );
          })}
          {pending.map((row, index) => (
            <div key={row.id} className="queue-band">
              {(total > 0 || index > 0) && <i className="queue-divider" aria-hidden="true" />}
              <div
                className="queue-row queue-pending"
                role="group"
                aria-label={`${row.status}: ${row.text}`}
              >
                <span className="queue-arc">
                  <TurningArc />
                </span>
                <span className="queue-text">{preview(row.text)}</span>
                <span className="queue-status">{row.status}</span>
              </div>
            </div>
          ))}
        </div>
      </div>
      {openMenu && (
        <QueueMenu
          index={rows.findIndex((row) => row.id === openMenu)}
          total={total}
          at={
            // A forced menu opens under the ⋯ button (`x` −1: 6px from the right edge).
            menu ?? { x: -1, y: 31 * rows.findIndex((row) => row.id === openMenu) + 22 }
          }
          onAction={(action) => {
            const id = openMenu;
            setMenu(null);
            if (action === "edit") onEdit(id);
            else onMove(id, action === "up" ? -1 : 1);
          }}
        />
      )}
    </div>
  );
}

function QueueMenu({
  index,
  total,
  at,
  onAction,
}: {
  index: number;
  total: number;
  at: { x: number; y: number };
  onAction: (action: "edit" | "up" | "down") => void;
}) {
  const items = [
    ["edit", "Edit", true],
    ["up", "Move up", index > 0],
    ["down", "Move down", index + 1 < total],
  ] as const;
  return (
    <div
      className="menu queue-menu"
      role="menu"
      style={
        at.x < 0
          ? { right: 6, left: "auto", top: at.y, width: "max-content" }
          : { left: at.x, top: at.y }
      }
    >
      {items.map(([action, label, enabled]) => (
        <button
          key={action}
          type="button"
          role="menuitem"
          disabled={!enabled}
          onClick={() => onAction(action)}
        >
          {label}
        </button>
      ))}
    </div>
  );
}
