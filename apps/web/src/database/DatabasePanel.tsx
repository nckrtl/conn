import { scopedThreadKey } from "@t3tools/client-runtime/environment";
import type { EnvironmentId, ScopedThreadRef } from "@t3tools/contracts";
import { ChevronDown, CircleAlert, Database, KeyRound, Play, Plus, Search } from "lucide-react";
import {
  type FormEvent,
  memo,
  useCallback,
  useEffect,
  useEffectEvent,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";

import { useProjectFileQuery } from "~/components/files/projectFilesQueryState";
import { Button } from "~/components/ui/button";
import { InputGroup, InputGroupAddon, InputGroupInput } from "~/components/ui/input-group";
import {
  Menu,
  MenuGroup,
  MenuGroupLabel,
  MenuItem,
  MenuPopup,
  MenuRadioGroup,
  MenuRadioItem,
  MenuSeparator,
  MenuTrigger,
} from "~/components/ui/menu";
import { RefreshIcon } from "~/components/ui/refresh-icon";
import { Spinner } from "~/components/ui/spinner";
import { Tooltip, TooltipPopup, TooltipTrigger } from "~/components/ui/tooltip";
import { cn } from "~/lib/utils";

import { ApiTabs } from "../api/ApiTabs";
import { ToolbarGroup } from "../components/ToolbarGroup";
import {
  browseTableSql,
  connectionFromEnv,
  connectionTarget,
  type DatabaseColumn,
  type DatabaseConnection,
  type DatabaseDriver,
  type DatabaseQueryResult,
  type DatabaseValue,
  defaultConnection,
  describeDatabaseTable,
  DRIVER_LABELS,
  listDatabaseTables,
  runReadOnlyQuery,
} from "./databaseApi";
import { useDatabaseStore } from "./databaseStore";
import vaultIcon from "./vault-icon.png";
import { type VaultDatabases, useVaultDatabases } from "./useVaultDatabases";

type ResultTab = "rows" | "structure";

const EMPTY_CONNECTIONS: readonly DatabaseConnection[] = [];

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Changes whenever anything that reaches the database changes, so loads run again. */
function connectionKey(connection: DatabaseConnection): string {
  const { id, driver, host, port, database, username, password } = connection;
  return JSON.stringify([id, driver, host, port, database, username, password]);
}

function Notice({ children }: { children: React.ReactNode }) {
  return (
    <div className="m-1 flex items-center gap-2 rounded-lg bg-warning/10 px-3 py-2 text-ui text-warning">
      <CircleAlert className="size-4 shrink-0" />
      <span className="min-w-0 break-words">{children}</span>
    </div>
  );
}

function Cell({ value }: { value: DatabaseValue | undefined }) {
  if (value === null || value === undefined) {
    return <span className="text-muted-foreground/70 italic">NULL</span>;
  }
  return <>{String(value)}</>;
}

// Memoized: `result` keeps its identity while the user types in the SQL box, so a keystroke
// does not rebuild the (up to 500 row) grid.
const RowsGrid = memo(function RowsGrid({ result }: { result: DatabaseQueryResult }) {
  if (result.columns.length === 0) {
    return (
      <p className="px-4 py-3 text-muted-foreground text-ui">The query returned no columns.</p>
    );
  }
  return (
    <table className="w-max min-w-full border-separate border-spacing-0 text-left font-mono text-xs">
      <thead>
        <tr>
          {result.columns.map((column) => (
            <th
              key={column}
              className="sticky top-0 z-10 h-8 border-b border-(--shell-divider)! bg-background px-3 font-medium text-muted-foreground first:ps-4"
            >
              {column}
            </th>
          ))}
        </tr>
      </thead>
      <tbody>
        {result.rows.map((row, index) => (
          // Rows have no stable identity; the result is replaced as a whole.
          // eslint-disable-next-line react/no-array-index-key
          <tr key={index} className="hover:bg-foreground/4">
            {result.columns.map((column) => (
              <td
                key={column}
                className="max-w-72 truncate border-b border-(--shell-divider)! px-3 py-1.5 first:ps-4"
              >
                <Cell value={row[column]} />
              </td>
            ))}
          </tr>
        ))}
      </tbody>
    </table>
  );
});

/** The filtered table buttons. Memoized so SQL keystrokes do not re-render the list. */
const TableList = memo(function TableList({
  names,
  selected,
  onOpen,
}: {
  names: readonly string[];
  selected: string | null;
  onOpen: (name: string) => void;
}) {
  return names.map((name) => (
    <button
      key={name}
      type="button"
      onClick={() => onOpen(name)}
      className={cn(
        "flex h-7 w-full cursor-pointer items-center rounded-(--control-radius) px-2.5 text-left text-ui outline-none focus-visible:ring-1 focus-visible:ring-ring",
        name === selected
          ? "bg-(--shell-highlight) text-foreground"
          : "text-muted-foreground hover:bg-foreground/4 hover:text-foreground",
      )}
    >
      <span className="truncate">{name}</span>
    </button>
  ));
});

function StructureList({ columns }: { columns: readonly DatabaseColumn[] }) {
  return (
    <div className="flex flex-col pb-2">
      {columns.map((column) => (
        <div
          key={column.name}
          className="flex items-center gap-3 border-b border-(--shell-divider)! py-2 ps-4 pe-toolbar-end text-ui"
        >
          <span className="flex w-2/5 min-w-0 items-center gap-1.5 font-mono text-xs">
            <span className="truncate">{column.name}</span>
            {column.primary ? (
              <KeyRound aria-label="Primary key" className="size-3.5 shrink-0 text-warning" />
            ) : null}
          </span>
          <span className="min-w-0 flex-1 truncate font-mono text-muted-foreground text-xs">
            {column.type}
            {column.nullable ? " · nullable" : ""}
            {column.default !== null ? ` · default ${column.default}` : ""}
          </span>
        </div>
      ))}
    </div>
  );
}

interface QueryState {
  readonly key: string;
  readonly running: boolean;
  readonly result: DatabaseQueryResult | null;
  readonly error: string | null;
}

interface LoadState<T> {
  readonly key: string;
  readonly data: T | null;
  readonly error: string | null;
}

/** Loads once per key; a new key shows loading until its own answer arrives. */
function useKeyedLoad<T>(key: string | null, load: () => Promise<T>) {
  const [state, setState] = useState<LoadState<T> | null>(null);
  const start = useEffectEvent(load);
  useEffect(() => {
    if (key === null) return;
    let cancelled = false;
    start().then(
      (data) => !cancelled && setState({ key, data, error: null }),
      (error: unknown) => !cancelled && setState({ key, data: null, error: message(error) }),
    );
    return () => {
      cancelled = true;
    };
  }, [key]);
  const settled = key !== null && state?.key === key ? state : null;
  return {
    data: settled?.data ?? null,
    error: settled?.error ?? null,
    loading: key !== null && settled === null,
  };
}

const fieldClass =
  "h-8 w-full rounded-(--toolbar-radius) border border-(--shell-divider-header)! bg-(--shell-field) px-3 text-ui text-foreground outline-none placeholder:text-muted-foreground/70 focus-visible:ring-1 focus-visible:ring-ring";

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="flex flex-col gap-1.5 text-muted-foreground text-ui">
      {label}
      {children}
    </label>
  );
}

/** Adds or edits a saved connection; the password stays in this app's local storage. */
function ConnectionForm({
  initial,
  onSave,
  onCancel,
}: {
  initial: DatabaseConnection;
  onSave: (connection: DatabaseConnection) => void;
  onCancel: () => void;
}) {
  const [draft, setDraft] = useState(initial);
  const set = (patch: Partial<DatabaseConnection>) => setDraft((value) => ({ ...value, ...patch }));
  const sqlite = draft.driver === "sqlite";
  const submit = (event: FormEvent) => {
    event.preventDefault();
    onSave({ ...draft, name: draft.name.trim() || connectionTarget(draft) });
  };
  return (
    <form
      onSubmit={submit}
      className="scrollbar-inset flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto px-4 py-3"
    >
      <Field label="Name">
        <input
          className={fieldClass}
          value={draft.name}
          onChange={(event) => set({ name: event.target.value })}
          placeholder={connectionTarget(draft) || "My database"}
        />
      </Field>
      <Field label="Driver">
        <ToolbarGroup className="w-fit">
          {(Object.keys(DRIVER_LABELS) as DatabaseDriver[]).map((driver) => (
            <Button
              key={driver}
              variant="ghost"
              size="xs"
              type="button"
              aria-pressed={draft.driver === driver}
              data-pressed={draft.driver === driver || undefined}
              onClick={() => set({ driver })}
            >
              <span className={draft.driver === driver ? "text-foreground" : undefined}>
                {DRIVER_LABELS[driver]}
              </span>
            </Button>
          ))}
        </ToolbarGroup>
      </Field>
      {sqlite ? (
        <Field label="File on this Mac">
          <input
            className={fieldClass}
            value={draft.database}
            onChange={(event) => set({ database: event.target.value })}
            placeholder="/Users/me/app/database/database.sqlite"
          />
        </Field>
      ) : (
        <>
          <div className="flex gap-3">
            <div className="min-w-0 flex-1">
              <Field label="Host">
                <input
                  className={fieldClass}
                  value={draft.host}
                  onChange={(event) => set({ host: event.target.value })}
                  placeholder="127.0.0.1"
                />
              </Field>
            </div>
            <div className="w-24">
              <Field label="Port">
                <input
                  className={fieldClass}
                  inputMode="numeric"
                  value={draft.port ?? ""}
                  onChange={(event) => {
                    const port = Number.parseInt(event.target.value, 10);
                    set({ port: Number.isFinite(port) ? port : null });
                  }}
                  placeholder={draft.driver === "pgsql" ? "5432" : "3306"}
                />
              </Field>
            </div>
          </div>
          <Field label="Database">
            <input
              className={fieldClass}
              value={draft.database}
              onChange={(event) => set({ database: event.target.value })}
            />
          </Field>
          <Field label="Username">
            <input
              className={fieldClass}
              value={draft.username}
              onChange={(event) => set({ username: event.target.value })}
              autoComplete="off"
            />
          </Field>
          <Field label="Password">
            <input
              className={fieldClass}
              type="password"
              value={draft.password}
              onChange={(event) => set({ password: event.target.value })}
              autoComplete="off"
            />
          </Field>
        </>
      )}
      <div className="flex justify-end gap-2 pt-1">
        <Button variant="ghost" size="sm" type="button" onClick={onCancel}>
          Cancel
        </Button>
        <Button variant="outline" size="sm" type="submit" disabled={draft.database.trim() === ""}>
          Save connection
        </Button>
      </div>
    </form>
  );
}

function newConnection(from: DatabaseConnection | null): DatabaseConnection {
  return {
    ...(from ?? {
      driver: "mysql" as const,
      host: "127.0.0.1",
      port: null,
      database: "",
      username: "",
      password: "",
    }),
    id: Math.random().toString(36).slice(2, 10),
    name: "",
    source: "manual",
  };
}

/** The Vault app icon, in front of connections that come from Vault. */
function VaultIcon() {
  return <img src={vaultIcon} alt="" aria-hidden className="size-4 shrink-0" />;
}

function ConnectionItems({ connections }: { connections: readonly DatabaseConnection[] }) {
  return connections.map((connection) => (
    <MenuRadioItem key={connection.id} value={connection.id}>
      {connection.source === "vault" ? <VaultIcon /> : null}
      <span className="truncate">{connection.name}</span>
      <span className="ms-auto truncate ps-3 text-muted-foreground">
        {connectionTarget(connection)}
      </span>
    </MenuRadioItem>
  ));
}

function ConnectionMenu({
  connections,
  vault,
  selected,
  onSelect,
  onUnlockVault,
  onAdd,
  onEdit,
  onDelete,
}: {
  connections: readonly DatabaseConnection[];
  vault: VaultDatabases;
  selected: DatabaseConnection | null;
  onSelect: (id: string) => void;
  onUnlockVault: () => void;
  onAdd: () => void;
  onEdit: () => void;
  onDelete: () => void;
}) {
  const select = (id: unknown) => onSelect(String(id));
  return (
    <Menu>
      <MenuTrigger
        render={<Button variant="ghost" size="xs" type="button" aria-label="Database connection" />}
      >
        {selected?.source === "vault" ? <VaultIcon /> : <Database />}
        <span className="truncate">{selected?.name ?? "Choose a connection"}</span>
        {selected ? (
          <span className="truncate text-muted-foreground">{connectionTarget(selected)}</span>
        ) : null}
        <ChevronDown />
      </MenuTrigger>
      <MenuPopup align="start" sideOffset={6}>
        {connections.length > 0 ? (
          <>
            <MenuRadioGroup value={selected?.id ?? ""} onValueChange={select}>
              <ConnectionItems connections={connections} />
            </MenuRadioGroup>
            <MenuSeparator />
          </>
        ) : null}
        {vault.available ? (
          <>
            <MenuGroup>
              <MenuGroupLabel>Vault</MenuGroupLabel>
              {vault.status === "locked" ? (
                <MenuItem onClick={onUnlockVault}>Unlock Vault…</MenuItem>
              ) : vault.status === "error" ? (
                <MenuItem disabled>{vault.error ?? "Vault is unavailable."}</MenuItem>
              ) : vault.status === "ok" && vault.connections.length === 0 ? (
                <MenuItem disabled>No Database entries</MenuItem>
              ) : (
                <MenuRadioGroup value={selected?.id ?? ""} onValueChange={select}>
                  <ConnectionItems connections={vault.connections} />
                </MenuRadioGroup>
              )}
            </MenuGroup>
            <MenuSeparator />
          </>
        ) : null}
        <MenuItem onClick={onAdd}>Add connection…</MenuItem>
        {selected && selected.source !== "vault" ? (
          <MenuItem onClick={onEdit}>
            {selected.source === "env" ? "Copy to a new connection…" : "Edit connection…"}
          </MenuItem>
        ) : null}
        {selected?.source === "manual" ? (
          <MenuItem onClick={onDelete}>Delete connection</MenuItem>
        ) : null}
      </MenuPopup>
    </Menu>
  );
}

/**
 * The Database surface: the project's database (from its `.env`) and saved connections, their
 * tables, a table's columns and read-only SQL. The desktop app connects directly.
 */
export function DatabasePanel({
  threadRef,
  projectKey,
  environmentId,
  cwd,
}: {
  threadRef: ScopedThreadRef;
  projectKey: string;
  environmentId: EnvironmentId;
  cwd: string;
}) {
  const threadKey = scopedThreadKey(threadRef);
  const envFile = useProjectFileQuery(environmentId, cwd, ".env");
  const envConnection = envFile.data ? connectionFromEnv(envFile.data.contents, cwd) : null;
  const saved = useDatabaseStore(
    (state) => state.byProjectKey[projectKey]?.connections ?? EMPTY_CONNECTIONS,
  );
  const remembered = useDatabaseStore(
    (state) => state.byProjectKey[projectKey]?.connection ?? null,
  );
  const pending = useDatabaseStore((state) => state.pendingByThreadKey[threadKey] ?? null);
  const vault = useVaultDatabases();
  const connections = envConnection ? [envConnection, ...saved] : saved;
  const connection = defaultConnection([...connections, ...vault.connections], remembered);
  // Set by any user action. Until then, a locked Vault never asks for Touch ID.
  const acted = useRef(false);
  const options = () => ({ allowUnlock: acted.current });
  const key = connection ? connectionKey(connection) : null;

  const [refreshNonce, setRefreshNonce] = useState(0);
  const [filter, setFilter] = useState("");
  const [tab, setTab] = useState<ResultTab>("rows");
  const [editing, setEditing] = useState<DatabaseConnection | null>(null);
  // Picks and results remember the connection they belong to, so a switch shows nothing stale.
  const [picked, setPicked] = useState<{ key: string; table: string } | null>(null);
  const [query, setQuery] = useState<QueryState | null>(null);
  const runId = useRef(0);
  const table = picked && picked.key === key ? picked.table : null;

  // Keys cover every connection field a call uses, so a load runs again exactly when they change.
  const tablesLoad = useKeyedLoad(key ? `${key}:${refreshNonce}` : null, () =>
    connection ? listDatabaseTables(connection, options()) : Promise.resolve([]),
  );
  const columnsLoad = useKeyedLoad(key && table ? `${key}:${table}` : null, () =>
    connection && table ? describeDatabaseTable(connection, table, options()) : Promise.resolve([]),
  );
  const columns = columnsLoad.data;

  const connectionId = connection?.id ?? null;
  const sql = useDatabaseStore((state) =>
    connectionId ? (state.byProjectKey[projectKey]?.sqlByConnection[connectionId] ?? "") : "",
  );
  const setSql = (next: string) => {
    if (connectionId) useDatabaseStore.getState().setSql(projectKey, connectionId, next);
  };
  const current = query && query.key === key ? query : null;
  const result = current?.result ?? null;
  const running = current?.running ?? false;

  const run = async (statement: string) => {
    if (!connection || !key || statement.trim() === "") return;
    acted.current = true;
    const id = ++runId.current;
    setTab("rows");
    setQuery((previous) => ({
      key,
      running: true,
      result: previous?.key === key ? previous.result : null,
      error: null,
    }));
    try {
      const next = await runReadOnlyQuery(connection, statement, options());
      if (id === runId.current) setQuery({ key, running: false, result: next, error: null });
    } catch (error) {
      if (id === runId.current) {
        setQuery({ key, running: false, result: null, error: message(error) });
      }
    }
  };

  // A query handed over from the Laravel Toolbar goes into the editor once a connection is
  // known. It does not run: the SQL comes from a web page, so the user reads it and runs it.
  useEffect(() => {
    if (!pending || !connectionId) return;
    useDatabaseStore.getState().clearPending(threadKey, pending.nonce);
    useDatabaseStore.getState().setSql(projectKey, connectionId, pending.sql);
  }, [connectionId, pending, projectKey, threadKey]);

  const openTable = (name: string) => {
    if (!connection || !key) return;
    const statement = browseTableSql(connection.driver, name);
    setPicked({ key, table: name });
    setSql(statement);
    void run(statement);
  };

  const tables = tablesLoad.data;
  const visibleTables = useMemo(() => {
    const needle = filter.trim().toLowerCase();
    return (tables ?? []).filter((name) => name.toLowerCase().includes(needle));
  }, [tables, filter]);
  // A stable identity for TableList; it always calls the latest `openTable`.
  const openTableRef = useRef(openTable);
  useLayoutEffect(() => {
    openTableRef.current = openTable;
  });
  const onOpenTable = useCallback((name: string) => openTableRef.current(name), []);
  const store = useDatabaseStore.getState;

  return (
    <div
      className="flex min-h-0 flex-1 flex-col bg-background"
      onKeyDown={(event) => {
        if (event.key === "Enter" && (event.metaKey || event.ctrlKey) && !editing) {
          event.preventDefault();
          void run(sql);
        }
      }}
    >
      <div
        className="flex shrink-0 items-center gap-2 border-b border-(--shell-divider)! bg-background py-toolbar ps-2 pe-toolbar-end"
        data-surface-subheader
      >
        <ToolbarGroup role="group" aria-label="Connection" className="min-w-0">
          <ConnectionMenu
            connections={connections}
            vault={vault}
            selected={connection}
            onSelect={(id) => {
              acted.current = true;
              store().setConnection(projectKey, id);
            }}
            onUnlockVault={() => {
              acted.current = true;
              vault.reload(true);
            }}
            onAdd={() => setEditing(newConnection(envConnection))}
            onEdit={() =>
              connection &&
              setEditing(connection.source === "env" ? newConnection(connection) : connection)
            }
            onDelete={() => connection && store().removeConnection(projectKey, connection.id)}
          />
        </ToolbarGroup>
        <span className="ms-auto shrink-0 text-muted-foreground text-ui">Read-only</span>
        <ToolbarGroup role="group" aria-label="Refresh">
          <Tooltip>
            <TooltipTrigger
              render={
                <Button
                  variant="ghost"
                  size="icon-xs"
                  type="button"
                  aria-label="Refresh"
                  onClick={() => {
                    acted.current = true;
                    envFile.refresh();
                    vault.reload(false);
                    setRefreshNonce((value) => value + 1);
                  }}
                />
              }
            >
              <RefreshIcon refreshing={tablesLoad.loading} />
            </TooltipTrigger>
            <TooltipPopup>Reload .env and tables</TooltipPopup>
          </Tooltip>
        </ToolbarGroup>
      </div>
      {editing ? (
        <ConnectionForm
          key={editing.id}
          initial={editing}
          onCancel={() => setEditing(null)}
          onSave={(next) => {
            store().saveConnection(projectKey, next);
            setEditing(null);
          }}
        />
      ) : !connection ? (
        <div className="flex flex-col items-start gap-3 px-4 py-3 text-muted-foreground text-ui">
          <p>
            {envFile.isPending
              ? "Reading the project's .env…"
              : "No database in the project's .env (DB_CONNECTION). Add a connection to browse one."}
          </p>
          <Button
            variant="outline"
            size="sm"
            type="button"
            onClick={() => setEditing(newConnection(null))}
          >
            <Plus />
            Add connection
          </Button>
        </div>
      ) : (
        <div className="flex min-h-0 flex-1">
          <div className="shell-divider-r flex w-52 shrink-0 flex-col">
            <div className="shrink-0 p-2">
              <InputGroup variant="soft" className="h-8">
                <InputGroupAddon>
                  <Search aria-hidden />
                </InputGroupAddon>
                <InputGroupInput
                  value={filter}
                  onChange={(event) => setFilter(event.target.value)}
                  placeholder="Tables"
                  aria-label="Filter tables"
                />
              </InputGroup>
            </div>
            <div className="scrollbar-inset min-h-0 flex-1 overflow-y-auto px-1.5 pb-2">
              {tablesLoad.error ? <Notice>{tablesLoad.error}</Notice> : null}
              {tablesLoad.loading ? (
                <div className="flex justify-center py-3 text-muted-foreground">
                  <Spinner className="size-4" />
                </div>
              ) : null}
              {tables && visibleTables.length === 0 ? (
                <p className="px-2.5 py-2 text-muted-foreground text-ui">No tables</p>
              ) : null}
              <TableList names={visibleTables} selected={table} onOpen={onOpenTable} />
            </div>
          </div>
          <div className="flex min-w-0 flex-1 flex-col">
            <textarea
              value={sql}
              onChange={(event) => setSql(event.target.value)}
              placeholder="select * from users limit 100"
              aria-label="SQL query"
              spellCheck={false}
              rows={5}
              className="block max-h-[40%] min-h-24 w-full shrink-0 resize-y border-b border-(--shell-divider)! bg-transparent px-4 py-3 font-mono text-xs text-foreground outline-none placeholder:text-muted-foreground/70"
            />
            <ApiTabs
              value={tab}
              onChange={setTab}
              tabs={[
                { id: "rows", label: "Rows", count: result?.rowCount },
                { id: "structure", label: "Structure", count: columns?.length },
              ]}
              trailing={
                <>
                  {result ? (
                    <span className="text-muted-foreground text-ui tabular-nums">
                      {result.truncated ? "First 500 rows · " : ""}
                      {Math.round(result.durationMs)} ms
                    </span>
                  ) : null}
                  <ToolbarGroup>
                    <Button
                      variant="ghost"
                      size="xs"
                      type="button"
                      onClick={() => void run(sql)}
                      disabled={running || sql.trim() === ""}
                    >
                      {running ? <Spinner className="size-3.5" /> : <Play />}
                      Run
                    </Button>
                  </ToolbarGroup>
                </>
              }
            />
            <div className="scrollbar-gutter-both scrollbar-inset min-h-0 flex-1 overflow-auto">
              {tab === "rows" ? (
                current?.error ? (
                  <Notice>{current.error}</Notice>
                ) : result ? (
                  <RowsGrid result={result} />
                ) : (
                  <p className="px-4 py-3 text-muted-foreground text-ui">
                    {running ? "Running…" : "Pick a table, or write a query and press ⌘↵."}
                  </p>
                )
              ) : !table ? (
                <p className="px-4 py-3 text-muted-foreground text-ui">
                  Pick a table to see its columns.
                </p>
              ) : columnsLoad.error ? (
                <Notice>{columnsLoad.error}</Notice>
              ) : columns ? (
                <StructureList columns={columns} />
              ) : (
                <div className="flex justify-center py-3 text-muted-foreground">
                  <Spinner className="size-4" />
                </div>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
