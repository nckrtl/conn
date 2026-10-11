import { Plus, X } from "lucide-react";
import { useState } from "react";

import { Button } from "~/components/ui/button";
import { Checkbox } from "~/components/ui/checkbox";

import { type ApiHeaderRow, type ApiRequestDraft, newRowId } from "./apiRequestStore";
import { ApiTabs } from "./ApiTabs";

type EditorTab = "headers" | "body";

const fieldClass =
  "min-w-0 flex-1 bg-transparent py-2 font-mono text-xs text-foreground outline-none placeholder:text-muted-foreground/70";

/** Name/value rows that can be switched off; `noun` names a row ("header", "variable"). */
export function HeaderRows({
  headers,
  onChange,
  noun = "header",
}: {
  headers: readonly ApiHeaderRow[];
  onChange: (headers: readonly ApiHeaderRow[]) => void;
  noun?: string;
}) {
  const Noun = noun.charAt(0).toUpperCase() + noun.slice(1);
  const update = (id: string, patch: Partial<ApiHeaderRow>) =>
    onChange(headers.map((row) => (row.id === id ? { ...row, ...patch } : row)));
  return (
    <div className="flex flex-col">
      {headers.map((row) => (
        <div
          key={row.id}
          className="group flex items-center gap-3 border-b border-(--shell-divider)! ps-4 pe-toolbar-end transition-colors hover:bg-foreground/4"
        >
          <Checkbox
            checked={row.enabled}
            onCheckedChange={(checked) => update(row.id, { enabled: checked === true })}
            aria-label={row.enabled ? `Disable ${noun}` : `Enable ${noun}`}
          />
          <input
            value={row.name}
            onChange={(event) => update(row.id, { name: event.target.value })}
            placeholder={Noun}
            aria-label={`${Noun} name`}
            className={fieldClass}
            data-disabled={!row.enabled || undefined}
          />
          <input
            value={row.value}
            onChange={(event) => update(row.id, { value: event.target.value })}
            placeholder="Value"
            aria-label={`${Noun} value`}
            className={fieldClass}
          />
          <span className="opacity-0 group-hover:opacity-100 has-focus-visible:opacity-100">
            <Button
              variant="ghost"
              size="icon-xs"
              type="button"
              aria-label={`Remove ${noun}`}
              onClick={() => onChange(headers.filter((candidate) => candidate.id !== row.id))}
            >
              <X />
            </Button>
          </span>
        </div>
      ))}
      <div className="ps-2.5 pt-1.5">
        <Button
          variant="ghost"
          size="xs"
          type="button"
          onClick={() =>
            onChange([...headers, { id: newRowId(), name: "", value: "", enabled: true }])
          }
        >
          <Plus />
          Add {noun}
        </Button>
      </div>
    </div>
  );
}

/** The request's headers and body, under the URL row. */
export function ApiRequestEditor({
  request,
  onChange,
}: {
  request: ApiRequestDraft;
  onChange: (patch: Partial<ApiRequestDraft>) => void;
}) {
  const [tab, setTab] = useState<EditorTab>("headers");
  const enabledHeaders = request.headers.filter((row) => row.enabled && row.name.trim()).length;
  const bodyless = request.method === "GET" || request.method === "HEAD";
  return (
    <div className="flex max-h-[45%] min-h-0 shrink-0 flex-col border-b border-(--shell-divider)!">
      <ApiTabs
        value={tab}
        onChange={setTab}
        tabs={[
          { id: "headers", label: "Headers", count: enabledHeaders },
          { id: "body", label: "Body" },
        ]}
      />
      <div className="scrollbar-inset min-h-0 overflow-y-auto pb-2">
        {tab === "headers" ? (
          <HeaderRows headers={request.headers} onChange={(headers) => onChange({ headers })} />
        ) : bodyless ? (
          <p className="px-4 py-3 text-muted-foreground text-ui">
            {request.method} requests send no body.
          </p>
        ) : (
          <textarea
            value={request.body}
            onChange={(event) => onChange({ body: event.target.value })}
            placeholder={'{\n  "name": "value"\n}'}
            aria-label="Request body"
            spellCheck={false}
            className="block min-h-32 w-full resize-y bg-transparent px-4 py-3 font-mono text-xs text-foreground outline-none placeholder:text-muted-foreground/70"
          />
        )}
      </div>
    </div>
  );
}
