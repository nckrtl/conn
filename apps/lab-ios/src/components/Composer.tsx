import { useLayoutEffect, useRef, useState } from "react";
import type { LabAttachment } from "../data/fixtures";
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
  allowsAttachments = true,
}: {
  value: string;
  onChange: (v: string) => void;
  onSend: (attachments: readonly LabAttachment[]) => void;
  onStop?: () => void;
  provider?: Provider;
  model?: string;
  onModel?: () => void;
  working?: boolean;
  canSend?: boolean;
  placeholder?: string;
  allowsAttachments?: boolean;
}) {
  const input = useRef<HTMLTextAreaElement>(null);
  const picker = useRef<HTMLInputElement>(null);
  const nextFileId = useRef(0);
  const [attachments, setAttachments] = useState<LabAttachment[]>([]);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- Fit the native one-to-four-line compositor to its DOM text.
  useLayoutEffect(() => {
    const el = input.current;
    if (el && el.value === value) {
      el.style.height = "44px";
      el.style.height = Math.min(113, Math.max(44, el.scrollHeight)) + "px";
    }
  }, [value]);
  const ready = canSend || !!value.trim() || attachments.length > 0;
  const busy = working && !ready;
  return (
    <div className="m-composer-slot">
      {!!attachments.length && (
        <ul className="m-draft-files" aria-label="Draft attachments">
          {attachments.map((file) => (
            <li key={file.id}>
              <Icon name="file-text" size={16} />
              <span>{file.name}</span>
              <button
                aria-label={`Remove ${file.name}`}
                onClick={() => {
                  setAttachments((files) => files.filter((f) => f.id !== file.id));
                  input.current?.focus();
                }}
              >
                <Icon name="close" size={14} />
              </button>
            </li>
          ))}
        </ul>
      )}
      <div className="m-composer m-continuous">
        {allowsAttachments && (
          <>
            <input
              ref={picker}
              type="file"
              multiple
              hidden
              onChange={(event) => {
                const picked = Array.from(event.currentTarget.files ?? [], (file) => ({
                  id: String(++nextFileId.current),
                  name: file.name,
                  size:
                    file.size < 1000
                      ? `${file.size} B`
                      : file.size < 1_000_000
                        ? `${Math.ceil(file.size / 1000)} KB`
                        : `${(file.size / 1_000_000).toFixed(1)} MB`,
                }));
                setAttachments((files) => [...files, ...picked]);
                event.currentTarget.value = "";
              }}
            />
            <button
              className="m-composer-plus"
              aria-label="Add attachment"
              onClick={() => picker.current?.click()}
            >
              <Icon name="add" size={20} />
            </button>
          </>
        )}
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
          disabled={!busy && !ready}
          onClick={
            busy
              ? onStop
              : () => {
                  onSend(attachments);
                  setAttachments([]);
                }
          }
        >
          <span>
            <Icon name={busy ? "stop" : "arrow-up"} size={busy ? 12 : 16} />
          </span>
        </button>
      </div>
    </div>
  );
}
