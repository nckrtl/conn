import { useLayoutEffect, useRef } from "react";
import { Icon, ProviderIcon, type Provider } from "./Icon";
import "./Composer.css";
export function Composer({
  value,
  onChange,
  onSend,
  onStop,
  provider,
  model,
  onModel,
  working = false,
  canSend = false,
  placeholder,
}: {
  value: string;
  onChange: (v: string) => void;
  onSend: () => void;
  onStop?: () => void;
  provider?: Provider;
  model?: string;
  onModel?: () => void;
  working?: boolean;
  canSend?: boolean;
  placeholder?: string;
}) {
  const input = useRef<HTMLTextAreaElement>(null);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- Fit the native one-to-four-line compositor to its DOM text.
  useLayoutEffect(() => {
    const el = input.current;
    if (el && el.value === value) {
      el.style.height = "44px";
      el.style.height = Math.min(113, Math.max(44, el.scrollHeight)) + "px";
    }
  }, [value]);
  const busy = working && !value.trim() && !canSend;
  return (
    <div className="m-composer-slot">
      <div className="m-composer m-continuous">
        <textarea
          rows={1}
          aria-label="Message"
          ref={input}
          className="m-composer-input"
          placeholder={placeholder ?? (working ? "Queue a follow-up…" : "Ask anything")}
          value={value}
          onChange={(e) => onChange(e.target.value)}
        />
        {working && !busy && onStop && (
          <button className="ios-stop" aria-label="Stop" onClick={onStop}>
            <Icon name="stop" size={13} />
          </button>
        )}
        {onModel && (
          <button className="m-composer-provider" aria-label={"Model, " + model} onClick={onModel}>
            <ProviderIcon provider={provider ?? "codex"} size={16} />
            <Icon name="chevron-down" size={10} />
          </button>
        )}
        <button
          className="m-composer-action"
          aria-label={busy ? "Stop" : "Send"}
          disabled={!busy && !canSend && !value.trim()}
          onClick={busy ? onStop : onSend}
        >
          <span>
            <Icon name={busy ? "stop" : "arrow-up"} size={busy ? 12 : 16} />
          </span>
        </button>
      </div>
    </div>
  );
}
