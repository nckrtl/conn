import { useEffect, useId, useRef, useState, type ReactNode } from "react";
import { Icon, Tool } from "./Icon";
import catalog from "./model-catalog.json";

const marks: Record<string, string> = {
  Favorites: "star",
  Claude: "claude",
  Codex: "openai",
  Antigravity: "antigravity",
  Grok: "grok",
};
const permissions = [
  ["Supervised", "Ask before commands and file changes."],
  ["Auto-accept edits", "Auto-approve edits, ask before other actions."],
  ["Auto", "Supported providers approve routine actions; others still ask."],
  ["Full access", "Allow commands and edits without prompts."],
] as const;
function effortLabel(id: string) {
  return id === "xhigh" ? "Extra High" : id.charAt(0).toUpperCase() + id.slice(1);
}
function shortName(name: string) {
  return name.replace(/^(Claude |Gemini |GPT-)/, "").replaceAll("-", " ");
}

function PickerSelect({
  label,
  description,
  value,
  onChange,
  options,
}: {
  label: string;
  description?: string | undefined;
  value: string;
  onChange: (value: string) => void;
  options: readonly { value: string; label: string }[];
}) {
  const id = useId();
  const trigger = useRef<HTMLButtonElement>(null);
  const menu = useRef<HTMLDivElement>(null);
  const [expanded, setExpanded] = useState(false);
  const selected = options.find((option) => option.value === value);

  function closeMenu() {
    trigger.current?.focus();
    menu.current?.hidePopover();
  }

  return (
    <div className="picker-select">
      <span id={id + "-label"}>{label}</span>
      <button
        ref={trigger}
        type="button"
        className="picker-select-field"
        popoverTarget={id}
        aria-haspopup="listbox"
        aria-expanded={expanded}
        aria-labelledby={id + "-label " + id + "-value"}
        aria-description={description}
        data-tip={description}
        onKeyDown={(event) => {
          if (
            (event.key === "ArrowDown" || event.key === "ArrowUp") &&
            !menu.current?.matches(":popover-open")
          ) {
            event.preventDefault();
            event.currentTarget.click();
          }
        }}
      >
        <span id={id + "-value"}>{selected?.label}</span>
        <Icon name="chevron-down" />
      </button>
      <div
        ref={menu}
        id={id}
        role="listbox"
        aria-labelledby={id + "-label"}
        popover="auto"
        className="menu picker-select-menu"
        onBeforeToggle={(event) => setExpanded(event.newState === "open")}
        onToggle={(event) => {
          if (event.currentTarget.matches(":popover-open")) {
            const chosen =
              event.currentTarget.querySelector<HTMLButtonElement>('[aria-selected="true"]');
            (chosen ?? event.currentTarget.querySelector("button"))?.focus();
          }
        }}
        onBlur={(event) => {
          if (
            event.relatedTarget !== trigger.current &&
            !event.currentTarget.contains(event.relatedTarget)
          ) {
            event.currentTarget.hidePopover();
          }
        }}
        onKeyDown={(event) => {
          if (event.key === "Escape") {
            event.preventDefault();
            event.stopPropagation();
            closeMenu();
            return;
          }
          if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) return;
          event.preventDefault();
          const items = Array.from(event.currentTarget.querySelectorAll("button"));
          const index = items.findIndex((item) => item === document.activeElement);
          const step = event.key === "ArrowUp" ? -1 : 1;
          const next =
            event.key === "Home"
              ? 0
              : event.key === "End"
                ? items.length - 1
                : (index + step + items.length) % items.length;
          items[next]?.focus();
        }}
      >
        {options.map((option) => (
          <button
            key={option.value}
            type="button"
            role="option"
            aria-selected={value === option.value}
            tabIndex={-1}
            onClick={() => {
              onChange(option.value);
              closeMenu();
            }}
          >
            {option.label}
            {value === option.value && <Icon name="check" />}
          </button>
        ))}
      </div>
    </div>
  );
}

export function Composer({
  abovePrompt,
  onSend,
  attachments,
  agentSmoke,
  running = false,
  editing,
}: {
  abovePrompt?: ReactNode;
  onSend: (text: string, followUp: string) => void;
  attachments?: ReactNode;
  agentSmoke: boolean;
  /** A turn runs: the send button queues or steers (`resolve_primary_action`). */
  running?: boolean;
  /** A queued message being edited: its text fills the prompt, and sending updates it. */
  editing?: { id: string; text: string } | undefined;
}) {
  // Editing a queued message moves its text into the prompt; the page re-keys the composer for it.
  const [draft, setDraft] = useState(editing?.text ?? "");
  const [speed, setSpeed] = useState(agentSmoke ? "Standard" : "Fast");
  // A follow-up queues behind the running turn unless Steer is chosen.
  const [followup, setFollowup] = useState("Queue");
  const [access, setAccess] = useState<string>(permissions[3][0]);
  const [picker, setPicker] = useState(false);
  const [model, setModel] = useState(
    catalog.find((m) => m.id === (agentSmoke ? "claude-haiku-5-5" : "gpt-6.2-astra"))!,
  );
  const [effort, setEffort] = useState(agentSmoke ? "medium" : "high");
  const [ultracode, setUltracode] = useState(false);
  const [search, setSearch] = useState("");
  const [provider, setProvider] = useState(model.provider);
  const [index, setIndex] = useState(0);
  const [favorites, setFavorites] = useState<string[]>([]);
  const trigger = useRef<HTMLButtonElement>(null);
  const q = search.trim().toLowerCase();
  const matches = catalog.filter((m) =>
    q
      ? [m.name, m.id, m.provider].some((s) => s.toLowerCase().includes(q))
      : provider === "Favorites"
        ? favorites.includes(m.id)
        : m.provider === provider,
  );
  if (provider !== "Favorites" || q)
    matches.sort((a, b) => Number(favorites.includes(b.id)) - Number(favorites.includes(a.id)));
  const showTraits = !!q || provider === "Favorites" || provider === model.provider;
  function dismiss() {
    setPicker(false);
  }
  const popup = useRef<HTMLDivElement>(null);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- Dismiss the native-style popover when a pointer lands outside it.
  useEffect(() => {
    if (!picker) return;
    function outside(e: PointerEvent) {
      if (
        e.target instanceof Node &&
        !popup.current?.contains(e.target) &&
        !trigger.current?.contains(e.target)
      ) {
        setPicker(false);
      }
    }
    document.addEventListener("pointerdown", outside, true);
    return () => document.removeEventListener("pointerdown", outside, true);
  }, [picker]);
  function pick(next: typeof model) {
    if (model.provider !== next.provider || !next.efforts.includes(effort))
      setEffort(next.defaultEffort ?? "");
    if (model.provider !== next.provider || !next.speeds.includes(speed))
      setSpeed(
        next.provider === "Codex" && next.speeds.includes("Fast") ? "Fast" : (next.speeds[0] ?? ""),
      );
    if (!next.ultracode) setUltracode(false);
    setModel(next);
  }
  function send() {
    if (!draft.trim() && !attachments) return;
    onSend(draft.trim(), followup);
    setDraft("");
  }
  return (
    <div className="composer-wrap">
      {abovePrompt}
      <div
        className="composer"
        onBlur={(event) => {
          if (!event.currentTarget.contains(event.relatedTarget)) dismiss();
        }}
        onKeyDown={(e) => {
          if (e.key === "Escape" && picker) {
            e.preventDefault();
            dismiss();
            trigger.current?.focus();
          }
        }}
      >
        {attachments}
        <textarea
          aria-label="Message"
          placeholder="Ask anything. @ files, $ skills, / commands"
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
              e.preventDefault();
              send();
            }
          }}
        />
        <div className="composer-tools">
          <span className="composer-attach" data-tip="Attach files">
            <Icon name="attach" />
          </span>
          <button
            ref={trigger}
            className="model-button"
            aria-expanded={picker}
            onClick={() => {
              setPicker(!picker);
              setIndex(0);
              setProvider(favorites.length ? "Favorites" : model.provider);
              setSearch("");
            }}
          >
            <Icon name={marks[model.provider]!} />
            {shortName(model.name)}
            <span>{effortLabel(effort)}</span>
          </button>
          <span className="composer-mic" aria-label="Dictate with Operator">
            <Icon name="microphone" />
          </span>
          {running && !editing && !draft.trim() && !attachments ? (
            <Tool label="Stop generation" data-stop="" icon="stop" data-tip="Interrupt" />
          ) : (
            <Tool
              label={
                editing
                  ? "Update queued message"
                  : running
                    ? followup === "Queue"
                      ? "Queue message"
                      : "Steer message"
                    : "Send message"
              }
              data-send=""
              icon={
                editing
                  ? "check"
                  : running
                    ? followup === "Queue"
                      ? "list-add"
                      : "forward"
                    : "arrow-up"
              }
              onClick={send}
              disabled={!draft.trim() && !attachments}
            />
          )}
        </div>
        {picker && (
          <div ref={popup} className="model-picker" role="dialog" aria-label="Model picker">
            <div className="providers" role="group" aria-label="Providers">
              {Object.keys(marks).map((p) => (
                <Tool
                  key={p}
                  label={p}
                  icon={marks[p]!}
                  showTooltip={false}
                  aria-pressed={!q && p === provider}
                  onClick={() => {
                    setSearch("");
                    setProvider(p);
                    setIndex(0);
                  }}
                />
              ))}
            </div>
            <div className="picker-panel">
              <div className="models">
                <label className="search">
                  <Icon name="search" />
                  <input
                    autoFocus
                    aria-label="Search models"
                    placeholder="Search models..."
                    value={search}
                    onChange={(e) => {
                      setSearch(e.target.value);
                      setIndex(0);
                    }}
                    onKeyDown={(e) => {
                      if (e.nativeEvent.isComposing || !matches.length) return;
                      if (e.key === "Enter") {
                        e.preventDefault();
                        pick(matches[index] ?? matches[0]!);
                      }
                      if (e.key === "ArrowUp" || e.key === "ArrowDown") {
                        e.preventDefault();
                        const next =
                          (index + (e.key === "ArrowDown" ? 1 : -1) + matches.length) %
                          matches.length;
                        setIndex(next);
                        document
                          .getElementById("choice-" + matches[next]!.id)
                          ?.scrollIntoView({ block: "nearest" });
                      }
                    }}
                  />
                </label>
                <div className="model-scroll">
                  {matches.map((m, i) => (
                    <div
                      id={"choice-" + m.id}
                      className="model-row"
                      key={m.id}
                      data-highlighted={i === index}
                    >
                      <button
                        className="model-option"
                        aria-pressed={model.id === m.id}
                        onClick={() => pick(m)}
                      >
                        <Icon name={marks[m.provider]!} />
                        {m.name}
                      </button>
                      <Tool
                        label={
                          (favorites.includes(m.id) ? "Remove from" : "Add to") +
                          " favorites: " +
                          m.name
                        }
                        icon="star"
                        aria-pressed={favorites.includes(m.id)}
                        onClick={() => {
                          setFavorites((list) =>
                            list.includes(m.id)
                              ? list.filter((id) => id !== m.id)
                              : [...list, m.id],
                          );
                          setIndex(0);
                        }}
                      />
                      <span className="active-check">
                        {model.id === m.id && <Icon name="check" />}
                      </span>
                    </div>
                  ))}
                  {!matches.length && (
                    <p className="empty">
                      {!q && provider === "Favorites" ? "No favorites yet" : "No models found"}
                    </p>
                  )}
                </div>
              </div>
              <div className="picker-options">
                {showTraits && model.efforts.length > 0 && (
                  <PickerSelect
                    label="Effort"
                    value={effort}
                    onChange={setEffort}
                    options={model.efforts.map((item) => ({
                      value: item,
                      label: effortLabel(item) + (item === model.defaultEffort ? " (default)" : ""),
                    }))}
                  />
                )}
                {showTraits && model.speeds.length > 0 && (
                  <PickerSelect
                    label="Speed"
                    value={speed}
                    onChange={setSpeed}
                    options={model.speeds.map((item) => ({ value: item, label: item }))}
                  />
                )}
                <PickerSelect
                  label="Follow-up messages"
                  value={followup}
                  onChange={setFollowup}
                  options={["Steer", "Queue"].map((item) => ({ value: item, label: item }))}
                />
                <PickerSelect
                  label="Permissions"
                  description={permissions.find(([label]) => label === access)?.[1]}
                  value={access}
                  onChange={setAccess}
                  options={permissions.map(([label]) => ({ value: label, label }))}
                />
                {showTraits && model.ultracode && (
                  <button
                    className="model-trait"
                    role="switch"
                    aria-label="Ultracode"
                    aria-checked={ultracode}
                    onClick={() => setUltracode(!ultracode)}
                  >
                    Ultracode
                    <i />
                  </button>
                )}
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
