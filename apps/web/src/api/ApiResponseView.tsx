import type { DesktopApiResponse } from "@t3tools/contracts";
import { CircleAlert } from "lucide-react";
import { useMemo, useState } from "react";

import { Spinner } from "~/components/ui/spinner";
import { StatusBadge } from "~/laravelToolbar/ui/parts";
import { formatBytes, formatMs } from "~/laravelToolbar/model";

import { ApiTabs } from "./ApiTabs";

type ResponseTab = "body" | "headers";

/** Pretty-printed JSON when the body parses as JSON, the text as sent otherwise. */
export function formatResponseBody(response: DesktopApiResponse): string {
  if (response.bodyEncoding === "base64") {
    return `Binary response (${formatBytes(response.size)}). The panel shows text bodies only.`;
  }
  const text = response.body;
  const type = response.headers.find((header) => header.name.toLowerCase() === "content-type");
  const looksJson = type?.value.includes("json") || /^\s*[[{]/.test(text);
  if (!looksJson) return text;
  try {
    return JSON.stringify(JSON.parse(text), null, 2);
  } catch {
    return text;
  }
}

function Notice({ children }: { children: React.ReactNode }) {
  return (
    <div className="m-1 flex items-center gap-2 rounded-lg bg-warning/10 px-3 py-2 text-ui text-warning">
      <CircleAlert className="size-4 shrink-0" />
      <span className="min-w-0">{children}</span>
    </div>
  );
}

export function ApiResponseView({
  response,
  sending,
}: {
  response: DesktopApiResponse | null;
  sending: boolean;
}) {
  const [tab, setTab] = useState<ResponseTab>("body");
  const body = useMemo(() => (response ? formatResponseBody(response) : ""), [response]);

  if (!response) {
    return (
      <div className="flex min-h-0 flex-1 items-center justify-center gap-2 px-4 text-center text-muted-foreground text-ui">
        {sending ? <Spinner className="size-4" /> : null}
        {sending ? "Sending…" : "Send the request to see the response."}
      </div>
    );
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <ApiTabs
        value={tab}
        onChange={setTab}
        tabs={[
          { id: "body", label: "Response" },
          { id: "headers", label: "Headers", count: response.headers.length },
        ]}
        trailing={
          sending ? (
            <span className="flex text-muted-foreground">
              <Spinner className="size-4" />
            </span>
          ) : response.error ? null : (
            <span className="flex items-center gap-2 text-muted-foreground text-ui tabular-nums">
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
      <div className="scrollbar-gutter-both scrollbar-inset min-h-0 flex-1 overflow-auto">
        {tab === "body" ? (
          <pre className="whitespace-pre-wrap break-all px-4 py-3 font-mono text-xs text-foreground">
            {body}
          </pre>
        ) : (
          <div className="flex flex-col pb-2">
            {response.headers.map((header) => (
              <div
                key={`${header.name}\u0000${header.value}`}
                className="flex gap-3 border-b border-(--shell-divider)! px-4 py-2 font-mono text-xs"
              >
                <span className="w-2/5 shrink-0 break-all text-muted-foreground">
                  {header.name}
                </span>
                <span className="min-w-0 break-all text-foreground">{header.value}</span>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
