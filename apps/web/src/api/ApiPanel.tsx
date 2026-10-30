import type { DesktopApiResponse, ScopedThreadRef } from "@t3tools/contracts";
import { ChevronDown, List, SendHorizontal } from "lucide-react";
import { type FormEvent, useCallback, useEffect } from "react";

import { Button } from "~/components/ui/button";
import { InputGroup, InputGroupAddon, InputGroupInput } from "~/components/ui/input-group";
import {
  Menu,
  MenuItem,
  MenuPopup,
  MenuRadioGroup,
  MenuRadioItem,
  MenuSeparator,
  MenuTrigger,
} from "~/components/ui/menu";
import { Spinner } from "~/components/ui/spinner";
import { Tooltip, TooltipPopup, TooltipTrigger } from "~/components/ui/tooltip";
import { BrowserLaravelToolbar } from "~/laravelToolbar/BrowserLaravelToolbar";
import { toolbarPayloadFromHeaders } from "~/laravelToolbar/headers";
import { rowFromData } from "~/laravelToolbar/model";
import { useLaravelToolbarStore } from "~/laravelToolbar/store";
import type { ToolbarData } from "~/laravelToolbar/types";

import { ToolbarGroup } from "../components/ToolbarGroup";
import { ApiRequestEditor } from "./ApiRequestEditor";
import {
  API_METHODS,
  type ApiRequestDraft,
  apiRequestLabel,
  newApiRequest,
  newRowId,
  useApiRequestStore,
} from "./apiRequestStore";
import { ApiResponseView } from "./ApiResponseView";
import { APP_BASE_NAME } from "../branding";

// Where each toolbar request came from, so its full payload can be loaded from that app.
const toolbarOrigins = new Map<string, string>();

function failedResponse(url: string, error: unknown): DesktopApiResponse {
  return {
    error: error instanceof Error ? error.message : String(error),
    status: 0,
    statusText: "",
    url,
    headers: [],
    body: "",
    bodyEncoding: "text",
    size: 0,
    truncated: false,
    durationMs: 0,
  };
}

/** `/_toolbar/requests/{id}` from the app that served the request; the payload is `raw`. */
async function fetchToolbarDetails(id: string): Promise<ToolbarData | null> {
  const origin = toolbarOrigins.get(id);
  const apiSend = window.desktopBridge?.apiSend;
  if (!origin || !apiSend) return null;
  const response = await apiSend({
    method: "GET",
    url: `${origin}/_toolbar/requests/${encodeURIComponent(id)}`,
    headers: [
      { name: "Accept", value: "application/json" },
      { name: "X-Laravel-Toolbar-Internal", value: "true" },
    ],
    body: null,
  }).catch(() => null);
  if (!response || response.error || response.status < 200 || response.status >= 300) return null;
  try {
    const parsed = JSON.parse(response.body) as { raw?: unknown };
    const raw = parsed.raw ?? parsed;
    return typeof raw === "object" && raw !== null && !Array.isArray(raw)
      ? (raw as ToolbarData)
      : null;
  } catch {
    return null;
  }
}

/** Hands the response's toolbar data to the bar under the panel. */
function receiveToolbarData(tabId: string, request: ApiRequestDraft, response: DesktopApiResponse) {
  const payload = toolbarPayloadFromHeaders(response.headers);
  if (!payload) return;
  try {
    toolbarOrigins.set(
      payload.kind === "full" ? payload.data.request_id! : payload.id,
      new URL(response.url).origin,
    );
  } catch {
    return;
  }
  const store = useLaravelToolbarStore.getState();
  if (payload.kind === "full") {
    const row = rowFromData(payload.data);
    if (row) store.receiveRequest(tabId, row, payload.data);
    return;
  }
  let uri = request.url;
  try {
    uri = new URL(request.url).pathname;
  } catch {
    // Keep the URL as typed.
  }
  store.receiveRequest(
    tabId,
    payload.row ?? { id: payload.id, method: request.method, uri, is_xhr: true },
    null,
  );
}

function MethodMenu({ method, onChange }: { method: string; onChange: (method: string) => void }) {
  return (
    <Menu>
      <MenuTrigger
        render={<Button variant="ghost" size="xs" type="button" aria-label="Request method" />}
      >
        <span className="font-mono">{method}</span>
        <ChevronDown />
      </MenuTrigger>
      <MenuPopup align="start" sideOffset={6}>
        <MenuRadioGroup value={method} onValueChange={(value) => onChange(String(value))}>
          {API_METHODS.map((candidate) => (
            <MenuRadioItem key={candidate} value={candidate}>
              <span className="font-mono">{candidate}</span>
            </MenuRadioItem>
          ))}
        </MenuRadioGroup>
      </MenuPopup>
    </Menu>
  );
}

function RequestsMenu({
  projectKey,
  requests,
  selected,
  baseUrl,
}: {
  projectKey: string;
  requests: readonly ApiRequestDraft[];
  selected: ApiRequestDraft;
  baseUrl: string | null;
}) {
  const store = useApiRequestStore.getState;
  return (
    <Menu>
      <Tooltip>
        <TooltipTrigger
          render={
            <MenuTrigger
              render={
                <Button variant="ghost" size="icon-xs" type="button" aria-label="Saved requests" />
              }
            />
          }
        >
          <List />
        </TooltipTrigger>
        <TooltipPopup>Requests</TooltipPopup>
      </Tooltip>
      <MenuPopup align="start" sideOffset={6}>
        <MenuRadioGroup
          value={selected.id}
          onValueChange={(id) => store().select(projectKey, String(id))}
        >
          {requests.map((request) => (
            <MenuRadioItem key={request.id} value={request.id}>
              <span className="truncate">{apiRequestLabel(request)}</span>
            </MenuRadioItem>
          ))}
        </MenuRadioGroup>
        <MenuSeparator />
        <MenuItem onClick={() => store().add(projectKey, newApiRequest(baseUrl))}>
          New request
        </MenuItem>
        <MenuItem
          onClick={() =>
            store().add(projectKey, {
              ...selected,
              id: newRowId(),
              headers: selected.headers.map((row) => ({ ...row, id: newRowId() })),
            })
          }
        >
          Duplicate
        </MenuItem>
        <MenuItem onClick={() => store().remove(projectKey, selected.id)}>Delete</MenuItem>
      </MenuPopup>
    </Menu>
  );
}

/**
 * The API surface: build a request, send it from the desktop app, read the response, and see
 * the Laravel Toolbar for it underneath, as under a browser page.
 */
export function ApiPanel({
  threadRef,
  projectKey,
  baseUrl,
}: {
  threadRef: ScopedThreadRef;
  projectKey: string;
  /** The project's app URL (its Orbit instance or a configured preview URL), for new requests. */
  baseUrl: string | null;
}) {
  const project = useApiRequestStore((state) => state.byProjectKey[projectKey]);
  const requests = project?.requests ?? [];
  const selected =
    requests.find((request) => request.id === project?.selectedId) ?? requests[0] ?? null;
  const result = useApiRequestStore((state) => (selected ? state.results[selected.id] : undefined));
  const toolbarTabId = `api:${projectKey}`;
  const apiSend = typeof window !== "undefined" ? window.desktopBridge?.apiSend : undefined;

  useEffect(() => {
    if (requests.length === 0)
      useApiRequestStore.getState().add(projectKey, newApiRequest(baseUrl));
  }, [baseUrl, projectKey, requests.length]);

  const change = useCallback(
    (patch: Partial<ApiRequestDraft>) => {
      if (selected) useApiRequestStore.getState().change(projectKey, selected.id, patch);
    },
    [projectKey, selected],
  );

  const send = useCallback(
    async (event?: FormEvent) => {
      event?.preventDefault();
      if (!selected || !apiSend || result?.sending) return;
      const store = useApiRequestStore.getState();
      const request = selected;
      store.setResult(request.id, { response: result?.response ?? null, sending: true });
      const response = await apiSend({
        method: request.method,
        url: request.url.trim(),
        headers: request.headers
          .filter((row) => row.enabled && row.name.trim())
          .map((row) => ({ name: row.name.trim(), value: row.value })),
        body: request.body === "" ? null : request.body,
      }).catch((error: unknown) => failedResponse(request.url, error));
      store.setResult(request.id, { response, sending: false });
      if (!response.error) receiveToolbarData(toolbarTabId, request, response);
    },
    [apiSend, result, selected, toolbarTabId],
  );

  if (!selected) return null;
  const sending = result?.sending ?? false;

  return (
    <div
      className="flex min-h-0 flex-1 flex-col bg-background"
      onKeyDown={(event) => {
        if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
          event.preventDefault();
          void send();
        }
      }}
    >
      <form
        onSubmit={(event) => void send(event)}
        className="flex shrink-0 items-center gap-2 border-b border-(--shell-divider)! bg-background py-toolbar ps-2 pe-toolbar-end in-data-[preview-panel-mode=inline]:mb-0 in-data-[preview-panel-mode=inline]:h-auto in-data-[preview-panel-mode=inline]:min-h-0"
        data-surface-subheader
      >
        <ToolbarGroup role="group" aria-label="Requests">
          <RequestsMenu
            projectKey={projectKey}
            requests={requests}
            selected={selected}
            baseUrl={baseUrl}
          />
        </ToolbarGroup>
        <InputGroup variant="soft" className="h-8 min-w-0 flex-1">
          <InputGroupAddon>
            <MethodMenu method={selected.method} onChange={(method) => change({ method })} />
          </InputGroupAddon>
          <InputGroupInput
            value={selected.url}
            onChange={(event) => change({ url: event.target.value })}
            placeholder="https://app.test/api/users"
            aria-label="Request URL"
            spellCheck={false}
          />
        </InputGroup>
        <ToolbarGroup role="group" aria-label="Send">
          <Tooltip>
            <TooltipTrigger
              render={
                <Button
                  variant="ghost"
                  size="icon-xs"
                  type="submit"
                  aria-label="Send request"
                  disabled={!apiSend || sending || selected.url.trim() === ""}
                />
              }
            >
              {sending ? <Spinner className="size-4" /> : <SendHorizontal />}
            </TooltipTrigger>
            <TooltipPopup>
              {apiSend ? "Send (⌘↵)" : `Needs the ${APP_BASE_NAME} desktop app`}
            </TooltipPopup>
          </Tooltip>
        </ToolbarGroup>
      </form>
      <ApiRequestEditor key={selected.id} request={selected} onChange={change} />
      <ApiResponseView
        key={`response:${selected.id}`}
        response={result?.response ?? null}
        sending={sending}
      />
      <BrowserLaravelToolbar
        tabId={toolbarTabId}
        threadRef={threadRef}
        pageUrl={result?.response?.url ?? selected.url}
        fetchDetails={fetchToolbarDetails}
      />
    </div>
  );
}
