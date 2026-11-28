import { useContext, useId, useRef, useState, type FormEvent, type ReactNode } from "react";
import {
  argumentsFromFields,
  fieldsFromSchema,
  type McpField,
} from "../../../lab-shared/mcpFields";
import { copyFeedText } from "../../../lab-ios/src/components/copyFeedText";
import HighlightedCode from "../../../lab-ios/src/components/HighlightedCode";
import { MarkdownText } from "../../../lab-ios/src/components/Markdown";
import { formatMs } from "../../../lab-shared/formatMs";
import { Icon, Tool } from "./Icon";
import { LabProjectContext } from "./LabProjectContext";
import {
  catalog,
  demoCommand,
  demoUrl,
  draft,
  fixtureId,
  handshake,
  initialServer,
  invoke,
  listings,
  protocol,
  record,
  serverInfo,
  type Catalog,
  type Draft,
  type Entry,
  type Exchange,
  type Pair,
  type Transport,
} from "./mcpFixture";
import "./McpPanel.css";

type Tab = Catalog | "Log" | "Server";
const tabs: Tab[] = ["Tools", "Resources", "Prompts", "Log", "Server"];
const transports: Transport[] = ["HTTP", "STDIO", "SSE"];
const action = { Tools: "Call", Resources: "Read", Prompts: "Get" };
const nouns = { Tools: "tool", Resources: "resource", Prompts: "prompt" };
const label = (s: Draft) =>
  s.name.trim() || (s.transport === "STDIO" ? s.command : s.url).trim() || "New server";
const json = (data: unknown) => JSON.stringify(data, null, 2);
type Workspace = { servers: Draft[]; selected: string };
const projects = new Map<string, Workspace>();
function initialWorkspace(project: string) {
  const saved = projects.get(project);
  if (saved) return saved;
  const first = initialServer();
  return { servers: [first], selected: first.id };
}

function PairEditor({
  pairs,
  field,
  change,
}: {
  pairs: Pair[];
  field: "header" | "variable";
  change: (pairs: Pair[]) => void;
}) {
  function patch(id: string, edit: Partial<Pair>) {
    change(pairs.map((row) => (row.id === id ? { ...row, ...edit } : row)));
  }
  return (
    <div className="mcp-pairs">
      <span>{field === "header" ? "Headers" : "Environment variables"}</span>
      {pairs.map((pair) => (
        <div key={pair.id} className="mcp-pair">
          <input
            type="checkbox"
            aria-label={"Enable " + field}
            checked={pair.enabled}
            onChange={(e) => patch(pair.id, { enabled: e.target.checked })}
          />
          <input
            aria-label={field + " name"}
            placeholder="Name"
            value={pair.name}
            onChange={(e) => patch(pair.id, { name: e.target.value })}
          />
          <input
            aria-label={field + " value"}
            placeholder="Value"
            value={pair.value}
            onChange={(e) => patch(pair.id, { value: e.target.value })}
          />
          <Tool
            label={"Remove " + field}
            icon="close"
            onClick={() => change(pairs.filter((p) => p.id !== pair.id))}
          />
        </div>
      ))}
      <button
        className="mcp-action"
        onClick={() => change([...pairs, { id: fixtureId(), name: "", value: "", enabled: true }])}
      >
        <Icon name="add" />
        Add {field}
      </button>
    </div>
  );
}
function ServerView({
  server,
  change,
}: {
  server: Draft;
  change: (patch: Partial<Draft>) => void;
}) {
  return (
    <div className="mcp-server mcp-scroll">
      {server.connected && (
        <section className="mcp-info">
          <strong>{serverInfo.title}</strong> <code>{serverInfo.version}</code>{" "}
          <small>{protocol}</small>
          <div>
            {["tools", "resources", "prompts", "logging"].map((c) => (
              <small key={c}>{c}</small>
            ))}
          </div>
        </section>
      )}
      <label>
        Name
        <input
          value={server.name}
          placeholder={label({ ...server, name: "" })}
          onChange={(e) => change({ name: e.target.value })}
        />
      </label>
      {server.transport === "STDIO" && (
        <label>
          Folder on this machine
          <input
            value={server.cwd}
            placeholder="Project folder"
            onChange={(e) => change({ cwd: e.target.value })}
          />
        </label>
      )}
      {server.transport === "STDIO" ? (
        <PairEditor pairs={server.env} field="variable" change={(env) => change({ env })} />
      ) : (
        <PairEditor
          pairs={server.headers}
          field="header"
          change={(headers) => change({ headers })}
        />
      )}
    </div>
  );
}
function Result({ result }: { result: Exchange }) {
  const [showJson, setShowJson] = useState(false);
  const [rawMarkdown, setRawMarkdown] = useState(false);
  const [copied, setCopied] = useState(false);
  const payload = result.result as
    | {
        content?: { text: string }[];
        contents?: { text: string; uri: string; mimeType: string }[];
        messages?: { role: string; content: { text: string } }[];
      }
    | undefined;
  const content =
    payload?.content?.[0]?.text ??
    payload?.contents?.[0]?.text ??
    payload?.messages?.[0]?.content.text ??
    "";
  const text = showJson ? json(result.result) : content;
  const isPrompt = !!payload?.messages?.length;
  const resource = payload?.contents?.[0];
  return (
    <>
      <nav className="mcp-tabs" aria-label="Call result">
        {["Result", "JSON"].map((name, i) => (
          <button
            key={name}
            aria-pressed={showJson === !!i}
            onClick={() => {
              setShowJson(!!i);
              setCopied(false);
            }}
          >
            {name}
          </button>
        ))}
        <span className="mcp-call-status">
          {result.error && <span>Error</span>}
          {result.durationMs !== undefined && formatMs(result.durationMs)}
        </span>
      </nav>
      {result.error ? (
        <div className="mcp-notice" role="alert">
          {result.error}
        </div>
      ) : (
        <div className="mcp-result-body">
          <div className="mcp-result-actions mcp-tools">
            {isPrompt && !showJson && (
              <Tool
                label={rawMarkdown ? "Show formatted" : "Show raw Markdown"}
                aria-pressed={rawMarkdown}
                icon={rawMarkdown ? "list" : "file-code"}
                onClick={() => setRawMarkdown(!rawMarkdown)}
              />
            )}
            <Tool
              label={copied ? "Copied" : showJson ? "Copy JSON" : "Copy raw text"}
              icon={copied ? "check" : "copy"}
              onClick={async () => setCopied(await copyFeedText(text))}
            />
          </div>
          <div className="mcp-output">
            {!showJson && resource && (
              <p>
                {resource.uri} · {resource.mimeType}
              </p>
            )}
            {!showJson && isPrompt ? (
              <>
                <span className="mcp-message-role">{payload.messages?.[0]?.role}</span>
                {rawMarkdown ? <pre>{text}</pre> : <MarkdownText markdown={text} />}
              </>
            ) : (
              <pre>
                <HighlightedCode code={text} language="json" />
              </pre>
            )}
          </div>
        </div>
      )}
    </>
  );
}

function FieldInput({
  field,
  value,
  onChange,
}: {
  field: McpField;
  value: string;
  onChange: (value: string) => void;
}) {
  switch (field.type) {
    case "boolean":
      return (
        <input
          type="checkbox"
          checked={value === "true"}
          onChange={(event) => onChange(String(event.target.checked))}
          aria-label={field.name}
        />
      );
    case "enum":
      return (
        <select
          value={value}
          onChange={(event) => onChange(event.target.value)}
          aria-label={field.name}
        >
          <option value="" disabled>
            Choose…
          </option>
          {field.options.map((option) => (
            <option key={option}>{option}</option>
          ))}
        </select>
      );
    case "json":
      return (
        <textarea
          value={value}
          onChange={(event) => onChange(event.target.value)}
          placeholder="{}"
          aria-label={field.name}
          spellCheck={false}
          rows={3}
        />
      );
    default:
      return (
        <input
          value={value}
          onChange={(event) => onChange(event.target.value)}
          inputMode={field.type === "string" ? undefined : "decimal"}
          aria-label={field.name}
          spellCheck={false}
        />
      );
  }
}

function FieldsForm({
  fields,
  values,
  onChange,
}: {
  fields: readonly McpField[];
  values: Readonly<Record<string, string>>;
  onChange: (values: Record<string, string>) => void;
}) {
  return (
    <div className="mcp-fields-form">
      {fields.map((field) => (
        <label key={field.name}>
          <span className="mcp-field-label">
            <span className="mcp-field-name" data-tip={field.description ?? undefined}>
              <code>{field.name}</code>
              {field.required && <span className="mcp-required">*</span>}
            </span>
            <span>{field.type}</span>
          </span>
          <FieldInput
            field={field}
            value={values[field.name] ?? field.defaultText}
            onChange={(value) => onChange({ ...values, [field.name]: value })}
          />
        </label>
      ))}
    </div>
  );
}

const toolHints = [
  ["readOnlyHint", "read-only", "Reads data without making changes."],
  ["destructiveHint", "destructive", "May remove or overwrite data."],
  ["idempotentHint", "idempotent", "Repeating the same call has no additional effect."],
  ["openWorldHint", "open world", "May interact with external systems."],
] as const;

function FieldsList({
  fields,
  schema,
}: {
  fields: readonly McpField[];
  schema: Entry["inputSchema"];
}) {
  return (
    <section className="mcp-fields-list" aria-label="Input">
      <p>Input</p>
      <div>
        {fields.map((field) => {
          const examples = schema?.properties[field.name]?.examples;
          return (
            <div key={field.name}>
              <span className="mcp-field-name">
                <code>{field.name}</code>
                <span>{field.type}</span>
                {field.required && <span>required</span>}
              </span>
              {field.description && <span>{field.description}</span>}
              {field.options.length > 0 && <code>{field.options.join(" | ")}</code>}
              {!!examples?.length && (
                <span className="mcp-field-examples">
                  {examples.length === 1 ? "Example" : "Examples"}{" "}
                  <code>{examples.map((value) => JSON.stringify(value)).join(", ")}</code>
                </span>
              )}
            </div>
          );
        })}
      </div>
    </section>
  );
}

function ItemDetail({
  item,
  kind,
  play,
  setPlay,
  fields,
  form,
  run,
  error,
  result,
}: {
  item: Entry;
  kind: Catalog;
  play: boolean;
  setPlay: (value: boolean) => void;
  fields: readonly McpField[];
  form: ReactNode;
  run: () => void;
  error: string;
  result: ReactNode;
}) {
  const exampleInputs = [...new Set(item.inputSchema?.examples?.map(json))];
  function submit(event: FormEvent) {
    event.preventDefault();
    run();
  }

  return (
    <div className="mcp-item">
      <nav className="mcp-tabs" aria-label="Item detail">
        {["Overview", "Playground"].map((name, i) => (
          <button key={name} aria-pressed={play === !!i} onClick={() => setPlay(!!i)}>
            {name}
          </button>
        ))}
      </nav>
      {!play ? (
        <div className="mcp-info mcp-scroll">
          <div className="mcp-item-summary">
            <div className="mcp-item-title">
              <strong>{item.name}</strong>
              {toolHints.map(
                ([hint, label, description]) =>
                  item.annotations?.[hint] === true && (
                    <span className="mcp-hint" data-hint={hint} data-tip={description} key={hint}>
                      {label}
                    </span>
                  ),
              )}
              {kind === "Resources" && <small>application/json</small>}
            </div>
            <p>{item.description}</p>
          </div>
          {item.uri && <code>{item.uri}</code>}
          {kind !== "Resources" && fields.length > 0 && (
            <FieldsList fields={fields} schema={item.inputSchema} />
          )}
          {exampleInputs.length > 0 && (
            <details key={item.name} className="mcp-input-examples">
              <summary>Example inputs ({exampleInputs.length})</summary>
              {exampleInputs.map((example) => (
                <pre key={example}>
                  <HighlightedCode code={example} language="json" />
                </pre>
              ))}
            </details>
          )}
        </div>
      ) : (
        <>
          <form
            className="mcp-call"
            data-mcp-call
            onSubmit={submit}
            onKeyDown={(event) => {
              if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) submit(event);
            }}
          >
            <div className="mcp-call-toolbar">
              <code>{item.name}</code>
              <button className="mcp-action" type="submit">
                <Icon name="play" />
                {action[kind]}
              </button>
            </div>
            {form ?? <p>This {nouns[kind]} takes no arguments.</p>}
            {error && (
              <span role="alert" className="mcp-notice">
                {error}
              </span>
            )}
          </form>
          {result}
        </>
      )}
    </div>
  );
}

function CatalogView({
  kind,
  item,
  select,
  play,
  setPlay,
  server,
  change,
}: {
  kind: Catalog;
  item: Entry;
  select: (entry: Entry) => void;
  play: boolean;
  setPlay: (value: boolean) => void;
  server: Draft;
  change: (patch: Partial<Draft>) => void;
}) {
  const [search, setSearch] = useState("");
  const [error, setError] = useState("");
  const items = catalog[kind].filter((x) =>
    (x.name + " " + x.description).toLowerCase().includes(search.toLowerCase()),
  );
  const key = kind + ":" + item.name;
  const fields = fieldsFromSchema(
    item.inputSchema ??
      (item.field && {
        properties: { [item.field.name]: item.field },
        required: [item.field.name],
      }),
  );
  const values = server.values[key] ?? {};
  const result = server.calls[key];

  function run() {
    const missing = fields.find(
      (field) => field.required && !(values[field.name] ?? field.defaultText).trim(),
    );
    if (missing) {
      setError(missing.name + " is required.");
      return;
    }
    const parsed = argumentsFromFields(fields, values);
    if ("error" in parsed) {
      setError(parsed.error);
      return;
    }
    const input = item.inputSchema
      ? JSON.stringify(parsed.arguments)
      : item.field
        ? String(parsed.arguments[item.field.name])
        : "";
    const next = invoke(kind, item, input);
    setError("");
    change({ ...record(server, [next]), calls: { ...server.calls, [key]: next } });
  }
  return (
    <div className="mcp-catalog">
      <aside className="mcp-items">
        <div className="mcp-search-bar">
          <label className="mcp-search">
            <Icon name="search" />
            <input
              aria-label={"Filter " + kind.toLowerCase()}
              placeholder={kind}
              value={search}
              onChange={(e) => setSearch(e.target.value)}
            />
          </label>
        </div>
        <div className="mcp-items-list">
          {items.length === 0 && <p>No {kind.toLowerCase()}</p>}
          {items.map((entry) => (
            <div key={entry.name}>
              {kind === "Resources" && entry.field && !search && <small>Templates</small>}
              <button
                aria-pressed={entry === item}
                onClick={() => {
                  select(entry);
                  setError("");
                }}
              >
                {entry.name}
              </button>
            </div>
          ))}
        </div>
      </aside>
      <ItemDetail
        item={item}
        kind={kind}
        play={play}
        setPlay={setPlay}
        fields={fields}
        form={
          fields.length > 0 ? (
            <FieldsForm
              fields={fields}
              values={values}
              onChange={(next) => {
                setError("");
                change({ values: { ...server.values, [key]: next } });
              }}
            />
          ) : null
        }
        run={run}
        error={error}
        result={
          result ? (
            <Result key={key + server.seq} result={result} />
          ) : (
            <div className="mcp-empty">
              {kind === "Tools"
                ? "Call the tool to see its result."
                : kind === "Resources"
                  ? "Read the resource to see its contents."
                  : "Get the prompt to see its messages."}
            </div>
          )
        }
      />
    </div>
  );
}

function WorkspacePanel({ project }: { project: string }) {
  const [workspace, setWorkspace] = useState(() => initialWorkspace(project));
  const [tab, setTab] = useState<Tab>("Tools");
  const [play, setPlay] = useState(false);
  const [chosen, setChosen] = useState<Partial<Record<Catalog, Entry>>>({});
  const [menu, setMenu] = useState(false);
  const serverMenuId = useId();
  const menuButton = useRef<HTMLButtonElement>(null);
  const { servers, selected } = workspace;
  const server = servers.find((s) => s.id === selected) ?? servers[0]!;
  function save(next: Workspace) {
    projects.set(project, next);
    setWorkspace(next);
  }
  function change(patch: Partial<Draft>) {
    save({
      ...workspace,
      servers: servers.map((s) => (s.id === server.id ? { ...s, ...patch } : s)),
    });
  }
  function switchServer(next: Draft[], id: string) {
    save({ servers: next, selected: id });
    setMenu(false);
    setPlay(false);
    setChosen({});
    menuButton.current?.focus();
  }
  function add(s: Draft) {
    switchServer([...servers, s], s.id);
  }
  function toggle() {
    if (server.connected) {
      change({
        connected: false,
        error: "",
        calls: {},
        log: [
          ...server.log,
          {
            key: fixtureId(),
            time: new Date().toISOString().slice(11, 23),
            direction: "Closed",
            label: "Connection closed",
          },
        ],
      });
      return;
    }
    const stdio = server.transport === "STDIO";
    const address = (stdio ? server.command : server.url).trim();
    if (address !== (stdio ? demoCommand : demoUrl)) {
      change({
        error: !address
          ? stdio
            ? "Enter the command that starts the server."
            : "Enter the server URL."
          : "No fixture is available for this " + (stdio ? "command." : "URL."),
      });
      return;
    }
    change(record({ ...server, connected: true, error: "" }, handshake()));
  }
  return (
    <section
      className="mcp-lab"
      aria-label="MCP inspector"
      onKeyDown={(e) => {
        if (e.key === "Enter" && (e.metaKey || e.ctrlKey) && !server.connected) {
          e.preventDefault();
          toggle();
        }
      }}
    >
      <form
        className="mcp-toolbar"
        onSubmit={(e) => {
          e.preventDefault();
          toggle();
        }}
      >
        <div
          className="mcp-server-picker"
          onBlur={(e) => {
            if (!e.currentTarget.contains(e.relatedTarget)) setMenu(false);
          }}
          onKeyDown={(e) => {
            if (e.key === "Escape") {
              setMenu(false);
              menuButton.current?.focus();
            }
          }}
        >
          <button
            ref={menuButton}
            type="button"
            className="mcp-action"
            aria-label="Servers"
            aria-expanded={menu}
            aria-controls={serverMenuId}
            onClick={() => setMenu(!menu)}
          >
            <Icon name="list" />
          </button>
          {menu && (
            <div className="mcp-menu" id={serverMenuId}>
              {servers.map((s) => (
                <button
                  type="button"
                  key={s.id}
                  aria-pressed={s === server}
                  onClick={() => switchServer(servers, s.id)}
                >
                  {label(s)}
                  <span>{s.transport}</span>
                </button>
              ))}
              {!servers.some((s) => s.id === "project:orbit") && (
                <>
                  <small>From .mcp.json</small>
                  <button
                    type="button"
                    onClick={() =>
                      add({
                        ...draft("Orbit CLI", "STDIO"),
                        id: "project:orbit",
                        command: demoCommand,
                      })
                    }
                  >
                    Orbit CLI <span>STDIO</span>
                  </button>
                </>
              )}
              <hr />
              <button type="button" onClick={() => add(draft("", "HTTP", demoUrl))}>
                New server
              </button>
              <button
                type="button"
                onClick={() =>
                  add({
                    ...draft(label(server) + " copy", server.transport, server.url),
                    command: server.command,
                    cwd: server.cwd,
                    env: server.env.map((row) => ({ ...row })),
                    headers: server.headers.map((row) => ({ ...row })),
                  })
                }
              >
                Duplicate
              </button>
              <button
                type="button"
                onClick={() => {
                  const remaining = servers.filter((s) => s.id !== server.id);
                  if (!remaining.length) remaining.push(draft("", "HTTP", demoUrl));
                  switchServer(remaining, remaining[0]!.id);
                }}
              >
                Delete
              </button>
            </div>
          )}
        </div>
        <div className="mcp-endpoint">
          <select
            aria-label="Transport"
            value={server.transport}
            onChange={(e) => change({ transport: e.target.value as Transport })}
          >
            {transports.map((t) => (
              <option key={t}>{t}</option>
            ))}
          </select>
          <input
            aria-label={server.transport === "STDIO" ? "Command" : "Server URL"}
            placeholder={server.transport === "STDIO" ? demoCommand : demoUrl}
            value={server.transport === "STDIO" ? server.command : server.url}
            onChange={(e) =>
              change(
                server.transport === "STDIO"
                  ? { command: e.target.value }
                  : { url: e.target.value },
              )
            }
          />
        </div>
        <div className="mcp-tools">
          {server.connected && (
            <Tool
              icon="refresh"
              label="Reload lists"
              onClick={() => change(record(server, listings()))}
            />
          )}
          <Tool
            icon="plug"
            type="submit"
            aria-pressed={server.connected}
            label={server.connected ? "Disconnect" : "Connect"}
          />
        </div>
      </form>
      {server.error && (
        <div role="alert" className="mcp-notice">
          {server.error}
        </div>
      )}
      <nav className="mcp-tabs" aria-label="MCP sections">
        {tabs.map((t) => (
          <button key={t} aria-pressed={tab === t} onClick={() => setTab(t)}>
            {t}
            {t === "Log" ? (
              <span>{server.log.length}</span>
            ) : t !== "Server" && server.connected ? (
              <span>{catalog[t].length}</span>
            ) : null}
          </button>
        ))}
        {tab === "Log" && server.log.length > 0 ? (
          <Tool label="Clear log" icon="clean" onClick={() => change({ log: [] })} />
        ) : server.connected ? (
          <small className="mcp-connected">{serverInfo.title}</small>
        ) : null}
      </nav>
      {tab === "Server" ? (
        <ServerView server={server} change={change} />
      ) : tab === "Log" ? (
        <div className="mcp-log mcp-scroll">
          {server.log.length ? (
            server.log.map((row) => (
              <details key={row.key}>
                <summary>
                  <Icon
                    name={
                      row.direction === "Sent"
                        ? "arrow-up"
                        : row.direction === "Closed"
                          ? "plug"
                          : "chevron-down"
                    }
                  />
                  <span>{row.label}</span>
                  <code>{row.rpc && "#" + row.rpc}</code>
                  <time>{row.time}</time>
                </summary>
                {row.payload && <pre>{json(row.payload)}</pre>}
              </details>
            ))
          ) : (
            <div className="mcp-empty">Messages between the panel and the server appear here.</div>
          )}
        </div>
      ) : server.connected ? (
        <CatalogView
          key={server.id + tab}
          kind={tab}
          item={chosen[tab] ?? catalog[tab][0]!}
          select={(item) => setChosen({ ...chosen, [tab]: item })}
          play={play}
          setPlay={setPlay}
          server={server}
          change={change}
        />
      ) : (
        <div className="mcp-empty">Connect to the server to see its {tab.toLowerCase()}.</div>
      )}
    </section>
  );
}
export function McpPanel() {
  const project = useContext(LabProjectContext);
  return <WorkspacePanel key={project} project={project} />;
}
