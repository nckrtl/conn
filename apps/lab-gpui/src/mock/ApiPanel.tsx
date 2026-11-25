import {
  type FormEvent,
  type ReactNode,
  type RefObject,
  useContext,
  useEffect,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import { Icon, Tool } from "./Icon";
import { LabProjectContext } from "./LabProjectContext";
import {
  API_METHODS,
  type ApiHeaderRow,
  type ApiRequestDraft,
  type ApiResponse,
  apiRequestLabel,
  formatBytes,
  formatMs,
  initialRequests,
  newApiRequest,
  newRowId,
} from "./apiFixture";
import { projectApiSession, type ToolbarCapture } from "./apiSession";
import "./ApiPanel.css";

type EditorTab = "headers" | "body";
type ResponseTab = "body" | "headers";
type ToolbarPanelId = "request" | "timings" | "memory" | "database" | "models" | "environment";

function useDismiss(ref: RefObject<HTMLElement | null>, open: boolean, onClose: () => void) {
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- listens for outside presses and Escape while a popup is open
  useEffect(() => {
    if (!open) return;
    const press = (event: PointerEvent) => {
      if (!ref.current?.contains(event.target as Node)) onClose();
    };
    const key = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    document.addEventListener("pointerdown", press);
    document.addEventListener("keydown", key);
    return () => {
      document.removeEventListener("pointerdown", press);
      document.removeEventListener("keydown", key);
    };
  }, [ref, open, onClose]);
}

function statusTone(status: number) {
  return status >= 500 ? "error" : status >= 400 ? "warning" : status >= 300 ? "info" : "success";
}

function StatusBadge({ status }: { status: number }) {
  return (
    <span className="la-badge" data-tone={statusTone(status)}>
      {status}
    </span>
  );
}

function MethodBadge({ method }: { method: string }) {
  const tone =
    method === "GET"
      ? "info"
      : method === "POST"
        ? "success"
        : method === "DELETE"
          ? "error"
          : "warning";
  return (
    <span className="la-badge" data-tone={tone}>
      {method}
    </span>
  );
}

function Tabs<T extends string>({
  value,
  tabs,
  onChange,
  trailing,
}: {
  value: T;
  tabs: readonly { id: T; label: string; count?: number }[];
  onChange: (tab: T) => void;
  trailing?: ReactNode;
}) {
  return (
    <div className="la-tabs" role="tablist">
      {tabs.map((tab) => (
        <button
          key={tab.id}
          type="button"
          role="tab"
          aria-selected={value === tab.id}
          onClick={() => onChange(tab.id)}
        >
          {tab.label}
          {tab.count ? <span className="la-count">{tab.count}</span> : null}
        </button>
      ))}
      {trailing ? <div className="la-tabs-trailing">{trailing}</div> : null}
    </div>
  );
}

function MethodMenu({ method, onChange }: { method: string; onChange: (method: string) => void }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useDismiss(ref, open, () => setOpen(false));
  return (
    <div className="la-menu" ref={ref}>
      <button
        type="button"
        className="la-method"
        aria-label="Request method"
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen(!open)}
      >
        <span>{method}</span>
        <Icon name="chevron-down" />
      </button>
      {open ? (
        <div className="la-popup" role="menu" aria-label="Request method">
          {API_METHODS.map((candidate) => (
            <button
              key={candidate}
              type="button"
              role="menuitemradio"
              aria-checked={candidate === method}
              onClick={() => {
                onChange(candidate);
                setOpen(false);
              }}
            >
              <span className="la-check">
                {candidate === method ? <Icon name="check" /> : null}
              </span>
              <span className="la-mono">{candidate}</span>
            </button>
          ))}
        </div>
      ) : null}
    </div>
  );
}

function RequestsMenu({
  requests,
  selected,
  onSelect,
  onNew,
  onDuplicate,
  onDelete,
}: {
  requests: readonly ApiRequestDraft[];
  selected: ApiRequestDraft;
  onSelect: (id: string) => void;
  onNew: () => void;
  onDuplicate: () => void;
  onDelete: () => void;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useDismiss(ref, open, () => setOpen(false));
  const run = (action: () => void) => () => {
    action();
    setOpen(false);
  };
  return (
    <div className="la-menu" ref={ref}>
      <Tool
        icon="list"
        label="Saved requests"
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen(!open)}
      />
      {open ? (
        <div className="la-popup la-popup-wide" role="menu" aria-label="Saved requests">
          {requests.map((request) => (
            <button
              key={request.id}
              type="button"
              role="menuitemradio"
              aria-checked={request.id === selected.id}
              onClick={run(() => onSelect(request.id))}
            >
              <span className="la-check">
                {request.id === selected.id ? <Icon name="check" /> : null}
              </span>
              <span className="la-truncate">{apiRequestLabel(request)}</span>
            </button>
          ))}
          <hr />
          <button type="button" role="menuitem" onClick={run(onNew)}>
            <span className="la-check" />
            New request
          </button>
          <button type="button" role="menuitem" onClick={run(onDuplicate)}>
            <span className="la-check" />
            Duplicate
          </button>
          <button type="button" role="menuitem" onClick={run(onDelete)}>
            <span className="la-check" />
            Delete
          </button>
        </div>
      ) : null}
    </div>
  );
}

function HeaderRows({
  headers,
  onChange,
}: {
  headers: readonly ApiHeaderRow[];
  onChange: (headers: readonly ApiHeaderRow[]) => void;
}) {
  const update = (id: string, patch: Partial<ApiHeaderRow>) =>
    onChange(
      headers.map((candidate) => (candidate.id === id ? { ...candidate, ...patch } : candidate)),
    );
  return (
    <div className="la-rows">
      {headers.map((header) => (
        <div key={header.id} className="la-row">
          <input
            type="checkbox"
            checked={header.enabled}
            onChange={(event) => update(header.id, { enabled: event.target.checked })}
            aria-label={header.enabled ? "Disable header" : "Enable header"}
          />
          <input
            className="la-field"
            value={header.name}
            placeholder="Header"
            aria-label="Header name"
            spellCheck={false}
            data-disabled={!header.enabled || undefined}
            onChange={(event) => update(header.id, { name: event.target.value })}
          />
          <input
            className="la-field"
            value={header.value}
            placeholder="Value"
            aria-label="Header value"
            spellCheck={false}
            data-disabled={!header.enabled || undefined}
            onChange={(event) => update(header.id, { value: event.target.value })}
          />
          <button
            type="button"
            className="la-remove"
            aria-label="Remove header"
            onClick={() => onChange(headers.filter((candidate) => candidate.id !== header.id))}
          >
            <Icon name="close" />
          </button>
        </div>
      ))}
      <button
        type="button"
        className="la-add"
        onClick={() =>
          onChange([...headers, { id: newRowId(), name: "", value: "", enabled: true }])
        }
      >
        <Icon name="add" />
        Add header
      </button>
    </div>
  );
}

function RequestEditor({
  request,
  onChange,
}: {
  request: ApiRequestDraft;
  onChange: (patch: Partial<ApiRequestDraft>) => void;
}) {
  const [tab, setTab] = useState<EditorTab>("headers");
  const enabled = request.headers.filter((header) => header.enabled && header.name.trim()).length;
  const bodyless = request.method === "GET" || request.method === "HEAD";
  return (
    <div className="la-editor">
      <Tabs
        value={tab}
        onChange={setTab}
        tabs={[
          { id: "headers", label: "Headers", count: enabled },
          { id: "body", label: "Body" },
        ]}
      />
      <div className="la-editor-body">
        {tab === "headers" ? (
          <HeaderRows headers={request.headers} onChange={(headers) => onChange({ headers })} />
        ) : bodyless ? (
          <p className="la-note">{request.method} requests send no body.</p>
        ) : (
          <textarea
            className="la-textarea"
            value={request.body}
            placeholder={'{\n  "name": "value"\n}'}
            aria-label="Request body"
            spellCheck={false}
            onChange={(event) => onChange({ body: event.target.value })}
          />
        )}
      </div>
    </div>
  );
}

function formatResponseBody(response: ApiResponse): string {
  if (response.bodyEncoding === "base64") {
    return `Binary response (${formatBytes(response.size)}). The panel shows text bodies only.`;
  }
  const type = response.headers.find((header) => header.name.toLowerCase() === "content-type");
  const looksJson = type?.value.includes("json") || /^\s*[[{]/.test(response.body);
  if (!looksJson) return response.body;
  try {
    return JSON.stringify(JSON.parse(response.body), null, 2);
  } catch {
    return response.body;
  }
}

function Notice({ children }: { children: ReactNode }) {
  return (
    <div className="la-notice" role="alert">
      <span className="la-notice-mark" aria-hidden="true">
        !
      </span>
      <span>{children}</span>
    </div>
  );
}

function ResponseView({ response, sending }: { response: ApiResponse | null; sending: boolean }) {
  const [tab, setTab] = useState<ResponseTab>("body");
  if (!response) {
    return (
      <div className="la-empty" role="status">
        {sending ? <span className="la-spinner" aria-hidden="true" /> : null}
        {sending ? "Sending…" : "Send the request to see the response."}
      </div>
    );
  }
  const body = formatResponseBody(response);
  return (
    <div className="la-response">
      <Tabs
        value={tab}
        onChange={setTab}
        tabs={[
          { id: "body", label: "Response" },
          { id: "headers", label: "Headers", count: response.headers.length },
        ]}
        trailing={
          sending ? (
            <span className="la-spinner" aria-label="Sending" />
          ) : response.error ? null : (
            <span className="la-meta">
              <StatusBadge status={response.status} />
              <span>{formatMs(response.durationMs)}</span>
              <span>{formatBytes(response.size)}</span>
            </span>
          )
        }
      />
      {response.error ? <Notice>{response.error}</Notice> : null}
      {response.truncated ? (
        <Notice>The body is larger than 20 MB; the panel shows the first 20 MB.</Notice>
      ) : null}
      <div className="la-response-body">
        {tab === "body" ? (
          body === "" && !response.error ? (
            <p className="la-note">
              {response.status} {response.statusText}: the response has no body.
            </p>
          ) : (
            <pre>{body}</pre>
          )
        ) : (
          response.headers.map((header) => (
            <div key={`${header.name}\u0000${header.value}`} className="la-header-row">
              <span>{header.name}</span>
              <span>{header.value}</span>
            </div>
          ))
        )}
      </div>
    </div>
  );
}

const toolbarPills: readonly { id: ToolbarPanelId; icon: string; label: string }[] = [
  { id: "timings", icon: "clock", label: "Timings" },
  { id: "memory", icon: "chart", label: "Memory" },
  { id: "database", icon: "database", label: "Database" },
  { id: "models", icon: "layers", label: "Models" },
  { id: "environment", icon: "settings", label: "Environment" },
];

function KeyValue({ rows }: { rows: readonly (readonly [string, ReactNode])[] }) {
  return (
    <div className="la-kv">
      {rows.map(([key, value]) => (
        <div key={key}>
          <span>{key}</span>
          <span>{value}</span>
        </div>
      ))}
    </div>
  );
}

function ToolbarPopup({ id, state }: { id: ToolbarPanelId; state: ToolbarCapture }) {
  const { data } = state;
  const queryMs = data.queries.reduce((sum, query) => sum + query.ms, 0);
  if (id === "request") {
    return (
      <KeyValue
        rows={[
          ["Request", `${state.method} ${state.uri}`],
          ["Status", String(state.status)],
          ["Route", data.route],
          ["Action", data.action],
          ["Middleware", data.middleware.join(", ")],
          ["Request ID", data.requestId],
        ]}
      />
    );
  }
  if (id === "timings") {
    const total = data.stages.reduce((sum, stage) => sum + stage.ms, 0) || 1;
    return (
      <div className="la-stages">
        {data.stages.map((stage) => (
          <div key={stage.label}>
            <span>{stage.label}</span>
            <span className="la-stage-track">
              <span style={{ width: `${Math.max(2, (stage.ms / total) * 100)}%` }} />
            </span>
            <span>{formatMs(stage.ms)}</span>
          </div>
        ))}
      </div>
    );
  }
  if (id === "memory") {
    return (
      <KeyValue
        rows={[
          ["Used", `${data.memoryMb.toFixed(1)} MB`],
          ["Peak", `${data.peakMb.toFixed(1)} MB`],
        ]}
      />
    );
  }
  if (id === "database") {
    if (data.queries.length === 0) return <p className="la-note">No queries ran.</p>;
    const counts = new Map<string, number>();
    for (const query of data.queries) counts.set(query.sql, (counts.get(query.sql) ?? 0) + 1);
    return (
      <div className="la-queries">
        <p className="la-note">
          {data.queries.length} queries, {formatMs(queryMs)}
        </p>
        {data.queries.map((query, index) => (
          // oxlint-disable-next-line react/no-array-index-key -- the immutable trace can repeat identical queries
          <div key={`${query.sql}:${index}`}>
            <code>{query.sql}</code>
            <span>
              {(counts.get(query.sql) ?? 0) > 1 ? (
                <span className="la-badge" data-tone="warning">
                  ×{counts.get(query.sql)}
                </span>
              ) : null}
              {formatMs(query.ms)}
            </span>
          </div>
        ))}
      </div>
    );
  }
  if (id === "models") {
    if (data.models.length === 0) return <p className="la-note">No models were loaded.</p>;
    return (
      <KeyValue rows={data.models.map((model) => [model.name, String(model.count)] as const)} />
    );
  }
  return (
    <KeyValue
      rows={[
        ["Application", "conn-app"],
        ["Environment", "local"],
        ["Laravel", "13.2.0"],
        ["PHP", "8.5.1"],
        ["Debug", "enabled"],
      ]}
    />
  );
}

/** The Laravel Toolbar under the panel: one line of the last request, a pill per detail panel. */
function ToolbarBar({
  state,
  history,
  onSelect,
  onClear,
}: {
  state: ToolbarCapture;
  history: readonly ToolbarCapture[];
  onSelect: (capture: ToolbarCapture) => void;
  onClear: () => void;
}) {
  const [pinned, setPinned] = useState<ToolbarPanelId | "requests" | null>(null);
  const ref = useRef<HTMLDivElement>(null);
  useDismiss(ref, pinned !== null, () => setPinned(null));
  const queries = state.data.queries.length;
  const models = state.data.models.reduce((sum, model) => sum + model.count, 0);
  const badges: Record<string, string> = {
    timings: formatMs(state.durationMs),
    memory: `${state.data.memoryMb.toFixed(0)} MB`,
    database: String(queries),
    models: String(models),
  };
  const toggle = (id: ToolbarPanelId | "requests") => setPinned(pinned === id ? null : id);
  return (
    <div className="la-toolbar" ref={ref}>
      {pinned ? (
        <div className="la-toolbar-popup" role="dialog" aria-label={`${pinned} details`}>
          {pinned === "requests" ? (
            <div className="la-history">
              <header>
                <strong>Requests</strong>
                <button type="button" onClick={onClear} disabled={history.length < 2}>
                  Clear history
                </button>
              </header>
              {history.toReversed().map((entry) => (
                <button
                  type="button"
                  key={entry.data.requestId}
                  aria-pressed={entry === state}
                  onClick={() => onSelect(entry)}
                >
                  <MethodBadge method={entry.method} />
                  <span className="la-truncate">{entry.uri}</span>
                  <StatusBadge status={entry.status} />
                  <span>{formatMs(entry.durationMs)}</span>
                </button>
              ))}
            </div>
          ) : (
            <ToolbarPopup id={pinned} state={state} />
          )}
        </div>
      ) : null}
      <button
        type="button"
        className="la-pill"
        aria-label="Requests on this page"
        aria-pressed={pinned === "requests"}
        onClick={() => toggle("requests")}
      >
        <Icon name="list" />
        {history.length}
      </button>
      <button
        type="button"
        className="la-pill la-pill-request"
        aria-pressed={pinned === "request"}
        onClick={() => toggle("request")}
      >
        <MethodBadge method={state.method} />
        <StatusBadge status={state.status} />
        <span className="la-truncate">{state.uri}</span>
      </button>
      {toolbarPills.map((pill) => (
        <button
          key={pill.id}
          type="button"
          className="la-pill"
          aria-label={pill.label}
          aria-pressed={pinned === pill.id}
          onClick={() => toggle(pill.id)}
        >
          <Icon name={pill.icon} />
          {badges[pill.id] ? <span>{badges[pill.id]}</span> : null}
        </button>
      ))}
    </div>
  );
}

interface Drafts {
  readonly requests: readonly ApiRequestDraft[];
  readonly selectedId: string;
}

function loadDrafts(storageKey: string): Drafts {
  try {
    const saved = JSON.parse(window.localStorage.getItem(storageKey) ?? "null") as Drafts | null;
    if (
      saved &&
      Array.isArray(saved.requests) &&
      saved.requests.length > 0 &&
      saved.requests.every(
        (draft) =>
          draft &&
          typeof draft.id === "string" &&
          typeof draft.method === "string" &&
          typeof draft.url === "string" &&
          typeof draft.body === "string" &&
          Array.isArray(draft.headers) &&
          draft.headers.every(
            (header: ApiHeaderRow) =>
              header &&
              typeof header.id === "string" &&
              typeof header.name === "string" &&
              typeof header.value === "string" &&
              typeof header.enabled === "boolean",
          ),
      )
    ) {
      return saved;
    }
  } catch {
    // Storage may be blocked or contain an invalid draft.
  }
  const requests = initialRequests();
  return { requests, selectedId: requests[0]!.id };
}

export function ApiPanel() {
  const project = useContext(LabProjectContext);
  const storageKey = `conn-gpui-lab:api-drafts:v1:${project}`;
  return <ProjectApiPanel key={storageKey} storageKey={storageKey} />;
}

function ProjectApiPanel({ storageKey }: { storageKey: string }) {
  const [drafts, setDrafts] = useState(() => loadDrafts(storageKey));
  const { requests, selectedId } = drafts;
  const session = projectApiSession(storageKey);
  const { results, history, selectedCapture } = useSyncExternalStore(
    session.subscribe,
    session.snapshot,
    session.snapshot,
  );
  const capture = selectedCapture ?? history.at(-1);

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- writes the committed project drafts to local storage
  useEffect(() => {
    try {
      window.localStorage.setItem(storageKey, JSON.stringify(drafts));
    } catch {
      // The current project can still edit and send drafts in memory.
    }
  }, [drafts, storageKey]);

  const selected = requests.find((request) => request.id === selectedId) ?? requests[0]!;
  const result = results[selected.id];
  const sending = result?.sending ?? false;

  const change = (patch: Partial<ApiRequestDraft>) =>
    setDrafts((current) => ({
      ...current,
      requests: current.requests.map((request) =>
        request.id === selected.id ? { ...request, ...patch, id: request.id } : request,
      ),
    }));

  const add = (request: ApiRequestDraft) => {
    setDrafts((current) => ({
      requests: [...current.requests, request],
      selectedId: request.id,
    }));
  };

  const remove = () => {
    const index = requests.findIndex((request) => request.id === selected.id);
    const rest = requests.filter((request) => request.id !== selected.id);
    session.remove(selected.id);
    if (rest.length === 0) rest.push(newApiRequest());
    setDrafts({ requests: rest, selectedId: rest[Math.min(index, rest.length - 1)]!.id });
  };

  const send = (event?: FormEvent) => {
    event?.preventDefault();
    session.send(selected);
  };

  return (
    <section
      className="lab-api"
      aria-label="API"
      onKeyDown={(event) => {
        if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
          event.preventDefault();
          send();
        }
      }}
    >
      <form className="la-bar" onSubmit={send}>
        <RequestsMenu
          requests={requests}
          selected={selected}
          onSelect={(id) => setDrafts((current) => ({ ...current, selectedId: id }))}
          onNew={() => add(newApiRequest())}
          onDuplicate={() =>
            add({
              ...selected,
              id: newRowId(),
              headers: selected.headers.map((header) => ({ ...header, id: newRowId() })),
            })
          }
          onDelete={remove}
        />
        <div className="la-url">
          <MethodMenu method={selected.method} onChange={(method) => change({ method })} />
          <input
            value={selected.url}
            placeholder="https://app.test/api/users"
            aria-label="Request URL"
            spellCheck={false}
            onChange={(event) => change({ url: event.target.value })}
          />
        </div>
        <Tool
          type="submit"
          icon="send"
          label="Send (⌘↵)"
          aria-label="Send request"
          disabled={sending || selected.url.trim() === ""}
        />
      </form>
      <RequestEditor key={selected.id} request={selected} onChange={change} />
      <ResponseView
        key={`response:${selected.id}`}
        response={result?.response ?? null}
        sending={sending}
      />
      {capture ? (
        <ToolbarBar
          state={capture}
          history={history}
          onSelect={session.selectCapture}
          onClear={session.clearHistory}
        />
      ) : null}
    </section>
  );
}
