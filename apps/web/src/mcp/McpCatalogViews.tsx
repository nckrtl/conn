import type { DesktopMcpMethod, DesktopMcpResponse } from "@t3tools/contracts";
import { Check, ChevronDown, CircleAlert, Code2, Copy, Eye, Play, Search } from "lucide-react";
import { type FormEvent, type ReactNode, Suspense, useMemo, useState } from "react";

import ChatMarkdown from "~/components/ChatMarkdown";
import { HighlightedTokens } from "~/components/chat/HighlightedTokens";
import { Badge } from "~/components/ui/badge";
import { Button } from "~/components/ui/button";
import { Checkbox } from "~/components/ui/checkbox";
import { InputGroup, InputGroupAddon, InputGroupInput } from "~/components/ui/input-group";
import { Menu, MenuPopup, MenuRadioGroup, MenuRadioItem, MenuTrigger } from "~/components/ui/menu";
import { Spinner } from "~/components/ui/spinner";
import { Tooltip, TooltipPopup, TooltipTrigger } from "~/components/ui/tooltip";
import { useCopyToClipboard } from "~/hooks/useCopyToClipboard";
import { useTheme } from "~/hooks/useTheme";
import { formatBytes, formatMs } from "~/laravelToolbar/model";
import { cn } from "~/lib/utils";

import { ApiTabs } from "../api/ApiTabs";
import { ToolbarGroup } from "../components/ToolbarGroup";
import {
  argumentsFromFields,
  expandTemplate,
  fieldsFromSchema,
  type McpField,
  templateVariables,
} from "./mcpServers";
import {
  failMcpCall,
  type McpPrompt,
  type McpResource,
  type McpResourceTemplate,
  type McpSession,
  type McpTool,
  type McpDetailTab,
  runMcpCall,
  selectMcpTool,
  setMcpDetailTab,
  setMcpForm,
} from "./mcpStore";

// The Tools, Resources and Prompts tabs: a filterable list beside the selected item's form
// and its last result, like the Database panel's tables beside their rows.

const fieldClass =
  "w-full min-w-0 rounded-(--control-radius) border border-(--shell-divider)! bg-transparent px-2.5 py-1.5 font-mono text-xs text-foreground outline-none placeholder:text-muted-foreground/70 focus-visible:border-ring";

const EMPTY_VALUES: Readonly<Record<string, string>> = {};

export function Notice({ children }: { children: ReactNode }) {
  return (
    <div className="m-1 flex items-start gap-2 rounded-lg bg-warning/10 px-3 py-2 text-ui text-warning">
      <CircleAlert className="mt-0.5 size-4 shrink-0" />
      <span className="min-w-0 whitespace-pre-wrap break-words">{children}</span>
    </div>
  );
}

export function EmptyState({ children }: { children: ReactNode }) {
  return (
    <div className="flex min-h-0 flex-1 items-center justify-center px-4 text-center text-muted-foreground text-ui">
      {children}
    </div>
  );
}

/** The text pretty-printed when it is JSON, else null. */
function prettyJson(text: string): string | null {
  if (!/^\s*[[{]/.test(text)) return null;
  try {
    return JSON.stringify(JSON.parse(text), null, 2);
  } catch {
    return null;
  }
}

function Code({ children, json = false }: { children: string; json?: boolean }) {
  const { resolvedTheme } = useTheme();
  return (
    <pre className="whitespace-pre-wrap break-all font-mono text-xs text-foreground">
      {json ? (
        <Suspense fallback={children}>
          <HighlightedTokens code={children} language="json" theme={resolvedTheme} />
        </Suspense>
      ) : (
        children
      )}
    </pre>
  );
}

/** A text result: JSON highlighted, anything else rendered as Markdown unless `raw`. */
function ResultText({ text, raw }: { text: string; raw: boolean }) {
  const json = prettyJson(text);
  if (json !== null) return <Code json>{json}</Code>;
  if (raw) return <Code>{text}</Code>;
  // Tool output is untrusted: no raw HTML.
  return <ChatMarkdown text={text} cwd={undefined} parseRawHtml={false} />;
}

// ─── The list beside each tab ───────────────────────────────────────────────

interface ListItem {
  readonly id: string;
  readonly label: string;
  readonly detail?: string | undefined;
}

function ItemList({
  items,
  selectedId,
  onSelect,
  noun,
  error,
  loading,
  sections,
}: {
  items: readonly ListItem[];
  selectedId: string | null;
  onSelect: (id: string) => void;
  noun: string;
  error: string | undefined;
  loading: boolean;
  /** Item ids that start a titled group, such as the first template. */
  sections?: Readonly<Record<string, string>> | undefined;
}) {
  const [filter, setFilter] = useState("");
  const needle = filter.trim().toLowerCase();
  const visible = needle
    ? items.filter((item) => `${item.label} ${item.detail ?? ""}`.toLowerCase().includes(needle))
    : items;
  return (
    <div className="shell-divider-r flex w-52 shrink-0 flex-col">
      <div className="shrink-0 p-2">
        <InputGroup variant="soft" className="h-8">
          <InputGroupAddon>
            <Search aria-hidden />
          </InputGroupAddon>
          <InputGroupInput
            value={filter}
            onChange={(event) => setFilter(event.target.value)}
            placeholder={noun.charAt(0).toUpperCase() + noun.slice(1)}
            aria-label={`Filter ${noun}`}
          />
        </InputGroup>
      </div>
      <div className="scrollbar-inset min-h-0 flex-1 overflow-y-auto px-1.5 pb-2">
        {error ? <Notice>{error}</Notice> : null}
        {loading ? (
          <div className="flex justify-center py-3 text-muted-foreground">
            <Spinner className="size-4" />
          </div>
        ) : null}
        {!loading && visible.length === 0 ? (
          <p className="px-2.5 py-2 text-muted-foreground text-ui">No {noun}</p>
        ) : null}
        {visible.map((item) => (
          <div key={item.id}>
            {sections?.[item.id] && !needle ? (
              <p className="px-2.5 pt-3 pb-1 text-muted-foreground text-xs">{sections[item.id]}</p>
            ) : null}
            <button
              type="button"
              onClick={() => onSelect(item.id)}
              className={cn(
                "flex h-7 w-full cursor-pointer items-center rounded-(--control-radius) px-2.5 text-left text-ui outline-none focus-visible:ring-1 focus-visible:ring-ring",
                item.id === selectedId
                  ? "bg-(--shell-highlight) text-foreground"
                  : "text-muted-foreground hover:bg-foreground/4 hover:text-foreground",
              )}
            >
              <span className="truncate">{item.label}</span>
            </button>
          </div>
        ))}
      </div>
    </div>
  );
}

// ─── Forms ──────────────────────────────────────────────────────────────────

function EnumMenu({
  value,
  options,
  onChange,
  label,
}: {
  value: string;
  options: readonly string[];
  onChange: (value: string) => void;
  label: string;
}) {
  return (
    <Menu>
      <MenuTrigger render={<Button variant="outline" size="xs" type="button" aria-label={label} />}>
        <span className="font-mono">{value || "Choose…"}</span>
        <ChevronDown />
      </MenuTrigger>
      <MenuPopup align="start" sideOffset={6}>
        <MenuRadioGroup value={value} onValueChange={(next) => onChange(String(next))}>
          {options.map((option) => (
            <MenuRadioItem key={option} value={option}>
              <span className="font-mono">{option}</span>
            </MenuRadioItem>
          ))}
        </MenuRadioGroup>
      </MenuPopup>
    </Menu>
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
        <Checkbox
          checked={value === "true"}
          onCheckedChange={(checked) => onChange(checked === true ? "true" : "false")}
          aria-label={field.name}
        />
      );
    case "enum":
      return (
        <EnumMenu value={value} options={field.options} onChange={onChange} label={field.name} />
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
          className={cn(fieldClass, "block resize-y")}
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
          className={fieldClass}
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
  onChange: (values: Readonly<Record<string, string>>) => void;
}) {
  return (
    <div className="grid grid-cols-[minmax(6rem,30%)_minmax(0,1fr)] items-start gap-x-4 gap-y-3">
      {fields.map((field) => (
        <label key={field.name} className="contents">
          <span className="flex min-w-0 flex-col gap-0.5 pt-1.5">
            <span className="flex items-baseline gap-1.5 text-ui">
              <span className="truncate font-mono text-foreground">{field.name}</span>
              {field.required ? <span className="text-destructive">*</span> : null}
              <span className="text-muted-foreground text-xs">{field.type}</span>
            </span>
            {field.description ? (
              <span className="text-muted-foreground text-xs">{field.description}</span>
            ) : null}
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

/** The inputs an item takes, for its Overview tab. */
function FieldsList({ fields }: { fields: readonly McpField[] }) {
  return (
    <div className="flex flex-col gap-2">
      <p className="text-muted-foreground text-xs">Input</p>
      <div className="flex flex-col divide-y divide-(--shell-divider) rounded-lg border border-(--shell-divider)!">
        {fields.map((field) => (
          <div key={field.name} className="flex flex-col gap-0.5 px-3 py-2">
            <span className="flex items-baseline gap-1.5 text-ui">
              <span className="font-mono text-foreground">{field.name}</span>
              <span className="text-muted-foreground text-xs">{field.type}</span>
              {field.required ? (
                <span className="text-muted-foreground text-xs">required</span>
              ) : null}
            </span>
            {field.description ? (
              <span className="text-muted-foreground text-xs">{field.description}</span>
            ) : null}
            {field.options.length > 0 ? (
              <span className="font-mono text-muted-foreground text-xs">
                {field.options.join(" | ")}
              </span>
            ) : null}
          </div>
        ))}
      </div>
    </div>
  );
}

/**
 * The selected item in two tabs: Overview reads like documentation, Playground holds the inputs
 * with the run button on top and the result below.
 */
function ItemDetail({
  tab,
  onTabChange,
  title,
  name,
  description,
  badges,
  details,
  fields,
  noFields,
  runLabel,
  running,
  onRun,
  result,
}: {
  tab: McpDetailTab;
  onTabChange: (tab: McpDetailTab) => void;
  title: string;
  name: string | null;
  description: string | undefined;
  badges?: ReactNode;
  /** More of the Overview, under the description. */
  details?: ReactNode;
  /** The Playground's inputs, or null when the item takes none. */
  fields: ReactNode;
  noFields: string;
  runLabel: string;
  running: boolean;
  onRun: () => void;
  result: ReactNode;
}) {
  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (!running) onRun();
  };
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <ApiTabs
        value={tab}
        onChange={onTabChange}
        tabs={[
          { id: "overview", label: "Overview" },
          { id: "playground", label: "Playground" },
        ]}
      />
      {tab === "overview" ? (
        <div className="scrollbar-inset flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto px-4 py-3">
          <div className="flex flex-col gap-1">
            <div className="flex flex-wrap items-center gap-2">
              <span className="font-medium text-foreground text-ui">{title}</span>
              {name && name !== title ? (
                <span className="font-mono text-muted-foreground text-xs">{name}</span>
              ) : null}
              {badges}
            </div>
            {description ? (
              <p className="whitespace-pre-wrap text-muted-foreground text-ui">{description}</p>
            ) : null}
          </div>
          {details}
        </div>
      ) : (
        <>
          <form
            data-mcp-call
            onSubmit={submit}
            onKeyDown={(event) => {
              if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) submit(event);
            }}
            className="scrollbar-inset flex max-h-[50%] min-h-0 shrink-0 flex-col gap-3 overflow-y-auto border-b border-(--shell-divider)! px-4 py-3"
          >
            <div className="flex items-center justify-between gap-2">
              <span className="min-w-0 truncate font-mono text-muted-foreground text-xs">
                {name ?? title}
              </span>
              <ToolbarGroup>
                <Button variant="ghost" size="xs" type="submit" disabled={running}>
                  {running ? <Spinner className="size-3.5" /> : <Play />}
                  {runLabel}
                </Button>
              </ToolbarGroup>
            </div>
            {fields ?? <p className="text-muted-foreground text-ui">{noFields}</p>}
          </form>
          {result}
        </>
      )}
    </div>
  );
}

// ─── Results ────────────────────────────────────────────────────────────────

type ResultTab = "content" | "json";

function field(value: unknown, name: string): unknown {
  return typeof value === "object" && value !== null
    ? (value as Record<string, unknown>)[name]
    : undefined;
}

function str(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

/** One content block, or one resource's contents. */
function ContentBlock({ block, raw }: { block: unknown; raw: boolean }) {
  const type = str(field(block, "type"));
  const mimeType = str(field(block, "mimeType"));
  const data = str(field(block, "data"));
  if (type === "image" && data && mimeType) {
    return (
      <img
        src={`data:${mimeType};base64,${data}`}
        alt=""
        className="max-h-96 max-w-full rounded-md border border-(--shell-divider)!"
      />
    );
  }
  if (type === "audio" && data && mimeType) {
    return <audio controls src={`data:${mimeType};base64,${data}`} />;
  }
  if (type === "resource_link") {
    return (
      <p className="font-mono text-xs">
        <span className="text-muted-foreground">Link </span>
        {str(field(block, "uri"))}
      </p>
    );
  }
  // A resource's contents: in an embedded resource block, or straight from resources/read.
  const resource = type === "resource" ? field(block, "resource") : block;
  const text = str(field(block, "text")) ?? str(field(resource, "text"));
  const blob = str(field(resource, "blob"));
  const uri = str(field(resource, "uri"));
  const resourceMime = str(field(resource, "mimeType"));
  return (
    <div className="flex flex-col gap-1">
      {uri && type !== "text" ? (
        <p className="font-mono text-muted-foreground text-xs">
          {uri}
          {resourceMime ? ` · ${resourceMime}` : ""}
        </p>
      ) : null}
      {text !== null ? (
        <ResultText text={text} raw={raw} />
      ) : blob !== null ? (
        resourceMime?.startsWith("image/") ? (
          <img
            src={`data:${resourceMime};base64,${blob}`}
            alt=""
            className="max-h-96 max-w-full rounded-md border border-(--shell-divider)!"
          />
        ) : (
          <p className="text-muted-foreground text-ui">
            Binary contents ({formatBytes(Math.floor((blob.length * 3) / 4))}).
          </p>
        )
      ) : (
        <Code json>{JSON.stringify(block, null, 2)}</Code>
      )}
    </div>
  );
}

/** The blocks a result lists: content, a resource's contents, or prompt messages' content. */
function resultBlocks(result: unknown): unknown[] {
  const content = field(result, "content");
  const contents = field(result, "contents");
  const messages = field(result, "messages");
  if (Array.isArray(content)) return content;
  if (Array.isArray(contents)) return contents;
  if (Array.isArray(messages)) return messages.map((message) => field(message, "content"));
  return [];
}

/** The result's text as the server sent it, for copying. */
function rawResultText(result: unknown): string {
  const texts = resultBlocks(result).flatMap((block) => {
    const text = str(field(block, "text")) ?? str(field(field(block, "resource"), "text"));
    return text === null ? [] : [text];
  });
  return texts.length > 0 ? texts.join("\n\n") : JSON.stringify(result, null, 2);
}

/** True when a text block would render as Markdown, so raw and formatted differ. */
function hasMarkdown(result: unknown): boolean {
  return resultBlocks(result).some((block) => {
    const text = str(field(block, "text")) ?? str(field(field(block, "resource"), "text"));
    return text !== null && prettyJson(text) === null;
  });
}

function ResultActions({
  copyText,
  raw,
  onRawChange,
}: {
  copyText: string;
  raw: boolean | null;
  onRawChange: (raw: boolean) => void;
}) {
  const { copyToClipboard, isCopied } = useCopyToClipboard({ timeout: 1200 });
  const copyLabel = isCopied ? "Copied" : raw === null ? "Copy JSON" : "Copy raw text";
  const rawLabel = raw ? "Show formatted" : "Show raw Markdown";
  return (
    <ToolbarGroup className="pointer-events-auto">
      {raw === null ? null : (
        <Tooltip>
          <TooltipTrigger
            render={
              <Button
                type="button"
                variant="ghost"
                size="icon-xs"
                aria-label={rawLabel}
                aria-pressed={raw}
                onClick={() => onRawChange(!raw)}
              />
            }
          >
            {raw ? <Eye /> : <Code2 />}
          </TooltipTrigger>
          <TooltipPopup>{rawLabel}</TooltipPopup>
        </Tooltip>
      )}
      <Tooltip>
        <TooltipTrigger
          render={
            <Button
              type="button"
              variant="ghost"
              size="icon-xs"
              aria-label={copyLabel}
              onClick={() => copyToClipboard(copyText)}
            />
          }
        >
          {isCopied ? <Check /> : <Copy />}
        </TooltipTrigger>
        <TooltipPopup>{copyLabel}</TooltipPopup>
      </Tooltip>
    </ToolbarGroup>
  );
}

function ResultContent({ result, raw }: { result: unknown; raw: boolean }) {
  const content = field(result, "content");
  const contents = field(result, "contents");
  const messages = field(result, "messages");
  const structured = field(result, "structuredContent");
  const blocks = Array.isArray(content) ? content : Array.isArray(contents) ? contents : null;
  return (
    <div className="flex flex-col gap-3 px-4 py-3">
      {Array.isArray(messages)
        ? messages.map((message, index) => (
            // Messages have no identity; the result is replaced as a whole.
            // eslint-disable-next-line react/no-array-index-key
            <div key={index} className="flex flex-col gap-1">
              <Badge variant="outline" className="self-start">
                {str(field(message, "role")) ?? "message"}
              </Badge>
              <ContentBlock block={field(message, "content")} raw={raw} />
            </div>
          ))
        : null}
      {blocks?.map((block, index) => (
        // eslint-disable-next-line react/no-array-index-key
        <ContentBlock key={index} block={block} raw={raw} />
      ))}
      {structured !== undefined ? (
        <div className="flex flex-col gap-1">
          <p className="text-muted-foreground text-xs">Structured content</p>
          <Code json>{JSON.stringify(structured, null, 2)}</Code>
        </div>
      ) : null}
      {!blocks && !Array.isArray(messages) && structured === undefined ? (
        <Code json>{JSON.stringify(result, null, 2)}</Code>
      ) : null}
    </div>
  );
}

function ResultView({
  response,
  running,
  idle,
}: {
  response: DesktopMcpResponse | null;
  running: boolean;
  idle: string;
}) {
  const [tab, setTab] = useState<ResultTab>("content");
  const [raw, setRaw] = useState(false);
  if (!response) {
    return (
      <EmptyState>
        {running ? <Spinner className="me-2 size-4" /> : null}
        {running ? "Running…" : idle}
      </EmptyState>
    );
  }
  const isError = field(response.result, "isError") === true;
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <ApiTabs
        value={tab}
        onChange={setTab}
        tabs={[
          { id: "content", label: "Result" },
          { id: "json", label: "JSON" },
        ]}
        trailing={
          running ? (
            <span className="flex text-muted-foreground">
              <Spinner className="size-4" />
            </span>
          ) : (
            <span className="flex items-center gap-2 text-muted-foreground text-ui tabular-nums">
              {response.error || isError ? <Badge variant="error">Error</Badge> : null}
              <span>{formatMs(response.durationMs)}</span>
            </span>
          )
        }
      />
      <div className="relative flex min-h-0 flex-1 flex-col">
        {response.error ? null : (
          <div className="pointer-events-none absolute end-2 top-2 z-20">
            <ResultActions
              copyText={
                tab === "json"
                  ? JSON.stringify(response.result, null, 2)
                  : rawResultText(response.result)
              }
              raw={tab === "content" && hasMarkdown(response.result) ? raw : null}
              onRawChange={setRaw}
            />
          </div>
        )}
        <div className="scrollbar-inset min-h-0 flex-1 overflow-auto">
          {response.error ? (
            <Notice>{response.error}</Notice>
          ) : tab === "json" ? (
            <div className="px-4 py-3">
              <Code json>{JSON.stringify(response.result, null, 2)}</Code>
            </div>
          ) : (
            <ResultContent result={response.result} raw={raw} />
          )}
        </div>
      </div>
    </div>
  );
}

function useCall(session: McpSession, sessionKey: string, callKey: string | null) {
  const call = callKey ? session.calls[callKey] : undefined;
  const values = (callKey ? session.forms[callKey] : undefined) ?? EMPTY_VALUES;
  return {
    call,
    values,
    setValues: (next: Readonly<Record<string, string>>) => {
      if (callKey) setMcpForm(sessionKey, callKey, next);
    },
    run: (method: DesktopMcpMethod, params: unknown) => {
      if (callKey) void runMcpCall(sessionKey, callKey, method, params);
    },
    fail: (error: string) => {
      if (callKey) failMcpCall(sessionKey, callKey, error);
    },
  };
}

// ─── Tools ──────────────────────────────────────────────────────────────────

function ToolBadges({ tool }: { tool: McpTool }) {
  const hints = tool.annotations;
  if (!hints) return null;
  return (
    <>
      {hints.readOnlyHint ? <Badge variant="success">read-only</Badge> : null}
      {hints.destructiveHint ? <Badge variant="error">destructive</Badge> : null}
      {hints.idempotentHint ? <Badge variant="info">idempotent</Badge> : null}
      {hints.openWorldHint ? <Badge variant="outline">open world</Badge> : null}
    </>
  );
}

export function McpToolsView({ session, sessionKey }: { session: McpSession; sessionKey: string }) {
  const tools = session.tools ?? [];
  const tool =
    tools.find((candidate) => candidate.name === session.selectedTool) ?? tools[0] ?? null;
  const callKey = tool ? `tool:${tool.name}` : null;
  const { call, values, setValues, run, fail } = useCall(session, sessionKey, callKey);
  const fields = useMemo(() => fieldsFromSchema(tool?.inputSchema), [tool]);

  return (
    <div className="flex min-h-0 flex-1">
      <ItemList
        noun="tools"
        items={tools.map((candidate) => ({
          id: candidate.name,
          label: candidate.title ?? candidate.annotations?.title ?? candidate.name,
          detail: candidate.description,
        }))}
        selectedId={tool?.name ?? null}
        onSelect={(name) => selectMcpTool(sessionKey, name)}
        error={session.listErrors.tools}
        loading={session.tools === null}
      />
      <div className="flex min-w-0 flex-1 flex-col">
        {tool ? (
          <ItemDetail
            tab={session.detailTab}
            onTabChange={(tab) => setMcpDetailTab(sessionKey, tab)}
            title={tool.title ?? tool.annotations?.title ?? tool.name}
            name={tool.name}
            description={tool.description}
            badges={<ToolBadges tool={tool} />}
            details={fields.length > 0 ? <FieldsList fields={fields} /> : null}
            fields={
              fields.length > 0 ? (
                <FieldsForm fields={fields} values={values} onChange={setValues} />
              ) : null
            }
            noFields="This tool takes no arguments."
            runLabel="Call"
            running={call?.running ?? false}
            onRun={() => {
              const parsed = argumentsFromFields(fields, values);
              if ("error" in parsed) fail(parsed.error);
              else run("tools/call", { name: tool.name, arguments: parsed.arguments });
            }}
            result={
              <ResultView
                key={callKey}
                response={call?.response ?? null}
                running={call?.running ?? false}
                idle="Call the tool to see its result."
              />
            }
          />
        ) : (
          <EmptyState>{session.tools === null ? null : "This server has no tools."}</EmptyState>
        )}
      </div>
    </div>
  );
}

// ─── Resources ──────────────────────────────────────────────────────────────

type ResourceEntry =
  | { readonly kind: "resource"; readonly id: string; readonly resource: McpResource }
  | { readonly kind: "template"; readonly id: string; readonly template: McpResourceTemplate };

export function McpResourcesView({
  session,
  sessionKey,
}: {
  session: McpSession;
  sessionKey: string;
}) {
  const entries = useMemo<ResourceEntry[]>(
    () => [
      ...(session.resources ?? []).map((resource) => ({
        kind: "resource" as const,
        id: `resource:${resource.uri}`,
        resource,
      })),
      ...(session.templates ?? []).map((template) => ({
        kind: "template" as const,
        id: `template:${template.uriTemplate}`,
        template,
      })),
    ],
    [session.resources, session.templates],
  );
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const entry = entries.find((candidate) => candidate.id === selectedId) ?? entries[0] ?? null;
  const { call, values, setValues, run, fail } = useCall(session, sessionKey, entry?.id ?? null);
  const firstTemplate = entries.find((candidate) => candidate.kind === "template");
  const variables = entry?.kind === "template" ? templateVariables(entry.template.uriTemplate) : [];
  const item = entry?.kind === "resource" ? entry.resource : entry?.template;

  return (
    <div className="flex min-h-0 flex-1">
      <ItemList
        noun="resources"
        items={entries.map((candidate) =>
          candidate.kind === "resource"
            ? {
                id: candidate.id,
                label: candidate.resource.title ?? candidate.resource.name,
                detail: candidate.resource.uri,
              }
            : {
                id: candidate.id,
                label: candidate.template.title ?? candidate.template.name,
                detail: candidate.template.uriTemplate,
              },
        )}
        selectedId={entry?.id ?? null}
        onSelect={setSelectedId}
        error={session.listErrors.resources}
        loading={session.resources === null}
        sections={firstTemplate ? { [firstTemplate.id]: "Templates" } : undefined}
      />
      <div className="flex min-w-0 flex-1 flex-col">
        {entry && item ? (
          <ItemDetail
            tab={session.detailTab}
            onTabChange={(tab) => setMcpDetailTab(sessionKey, tab)}
            title={item.title ?? item.name}
            name={null}
            description={item.description}
            badges={item.mimeType ? <Badge variant="outline">{item.mimeType}</Badge> : null}
            details={
              <p className="break-all font-mono text-muted-foreground text-xs">
                {entry.kind === "resource" ? entry.resource.uri : entry.template.uriTemplate}
              </p>
            }
            fields={
              variables.length > 0 ? (
                <FieldsForm
                  fields={variables.map((name) => ({
                    name,
                    type: "string",
                    required: true,
                    description: null,
                    options: [],
                    defaultText: "",
                  }))}
                  values={values}
                  onChange={setValues}
                />
              ) : null
            }
            noFields="This resource takes no arguments."
            runLabel="Read"
            running={call?.running ?? false}
            onRun={() => {
              if (entry.kind === "resource") {
                run("resources/read", { uri: entry.resource.uri });
                return;
              }
              const missing = variables.find((name) => !(values[name] ?? "").trim());
              if (missing) fail(`${missing} is required.`);
              else
                run("resources/read", {
                  uri: expandTemplate(entry.template.uriTemplate, values),
                });
            }}
            result={
              <ResultView
                key={entry.id}
                response={call?.response ?? null}
                running={call?.running ?? false}
                idle="Read the resource to see its contents."
              />
            }
          />
        ) : (
          <EmptyState>
            {session.resources === null ? null : "This server has no resources."}
          </EmptyState>
        )}
      </div>
    </div>
  );
}

// ─── Prompts ────────────────────────────────────────────────────────────────

export function McpPromptsView({
  session,
  sessionKey,
}: {
  session: McpSession;
  sessionKey: string;
}) {
  const prompts = session.prompts ?? [];
  const [selectedName, setSelectedName] = useState<string | null>(null);
  const prompt: McpPrompt | null =
    prompts.find((candidate) => candidate.name === selectedName) ?? prompts[0] ?? null;
  const callKey = prompt ? `prompt:${prompt.name}` : null;
  const { call, values, setValues, run, fail } = useCall(session, sessionKey, callKey);
  const fields: McpField[] = (prompt?.arguments ?? []).map((argument) => ({
    name: argument.name,
    type: "string",
    required: argument.required === true,
    description: argument.description ?? null,
    options: [],
    defaultText: "",
  }));

  return (
    <div className="flex min-h-0 flex-1">
      <ItemList
        noun="prompts"
        items={prompts.map((candidate) => ({
          id: candidate.name,
          label: candidate.title ?? candidate.name,
          detail: candidate.description,
        }))}
        selectedId={prompt?.name ?? null}
        onSelect={setSelectedName}
        error={session.listErrors.prompts}
        loading={session.prompts === null}
      />
      <div className="flex min-w-0 flex-1 flex-col">
        {prompt ? (
          <ItemDetail
            tab={session.detailTab}
            onTabChange={(tab) => setMcpDetailTab(sessionKey, tab)}
            title={prompt.title ?? prompt.name}
            name={prompt.name}
            description={prompt.description}
            details={fields.length > 0 ? <FieldsList fields={fields} /> : null}
            fields={
              fields.length > 0 ? (
                <FieldsForm fields={fields} values={values} onChange={setValues} />
              ) : null
            }
            noFields="This prompt takes no arguments."
            runLabel="Get"
            running={call?.running ?? false}
            onRun={() => {
              const missing = fields.find(
                (candidate) => candidate.required && !(values[candidate.name] ?? "").trim(),
              );
              if (missing) {
                fail(`${missing.name} is required.`);
                return;
              }
              // Prompt arguments are strings; empty optional ones are left out.
              const args = Object.fromEntries(
                Object.entries(values).filter(([, value]) => value !== ""),
              );
              run("prompts/get", { name: prompt.name, arguments: args });
            }}
            result={
              <ResultView
                key={callKey}
                response={call?.response ?? null}
                running={call?.running ?? false}
                idle="Get the prompt to see its messages."
              />
            }
          />
        ) : (
          <EmptyState>{session.prompts === null ? null : "This server has no prompts."}</EmptyState>
        )}
      </div>
    </div>
  );
}
