// Decodes the Laravel Toolbar response headers. nckrtl/laravel-toolbar and php-data-bridge
// send `x-toolbar` (base64 JSON payload) or, when the payload is too big for a header,
// `x-toolbar-summary` (base64 `{ request_id, history_row }`); the full payload then comes from
// `/_toolbar/requests/{id}`. The web API panel and the desktop browser both read them.

type JsonObject = Record<string, unknown>;

export type ToolbarHeaderPayload =
  | { readonly kind: "full"; readonly data: JsonObject }
  | { readonly kind: "summary"; readonly id: string; readonly row: JsonObject | null };

function decodeBase64Json(value: string): JsonObject | null {
  try {
    // The servers may send URL-safe base64 without padding.
    const normalized = value.trim().replace(/-/g, "+").replace(/_/g, "/");
    const padded = normalized + "=".repeat((4 - (normalized.length % 4)) % 4);
    const binary = atob(padded);
    const bytes = Uint8Array.from(binary, (char) => char.charCodeAt(0));
    const parsed: unknown = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
    return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)
      ? (parsed as JsonObject)
      : null;
  } catch {
    return null;
  }
}

/**
 * The toolbar data in the `x-toolbar` and `x-toolbar-summary` header values, or null when
 * there is none or only broken data. A full payload wins over a summary.
 */
export function decodeToolbarHeaders(
  full: string | null | undefined,
  summary: string | null | undefined,
): ToolbarHeaderPayload | null {
  const data = full ? decodeBase64Json(full) : null;
  if (data && typeof data.request_id === "string") return { kind: "full", data };
  const decoded = summary ? decodeBase64Json(summary) : null;
  if (!decoded || typeof decoded.request_id !== "string") return null;
  const row = decoded.history_row;
  return {
    kind: "summary",
    id: decoded.request_id,
    row:
      typeof row === "object" && row !== null && typeof (row as { id?: unknown }).id === "string"
        ? (row as JsonObject)
        : null,
  };
}

/** A history row for a summary that came without one: enough for the bar to list it. */
export function minimalToolbarRow(
  id: string,
  request?: { readonly method?: string | undefined; readonly url?: string | undefined },
): { readonly id: string; readonly method: string; readonly uri: string } {
  let uri = "/";
  try {
    if (request?.url) {
      const url = new URL(request.url);
      uri = `${url.pathname}${url.search}`;
    }
  } catch {
    // Keep "/".
  }
  return { id, method: request?.method?.toUpperCase() || "GET", uri };
}
