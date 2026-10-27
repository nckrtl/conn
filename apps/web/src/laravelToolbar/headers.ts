// Reads the toolbar payload from response headers, for requests T3 sends itself (the API
// panel). Decoding rules: @t3tools/shared/laravelToolbarHeaders.
import { decodeToolbarHeaders } from "@t3tools/shared/laravelToolbarHeaders";

import type { ToolbarData, ToolbarHistoryRow } from "./types";

export type ToolbarHeaderPayload =
  | { readonly kind: "full"; readonly data: ToolbarData }
  | { readonly kind: "summary"; readonly id: string; readonly row: ToolbarHistoryRow | null };

function headerValue(
  headers: ReadonlyArray<{ readonly name: string; readonly value: string }>,
  name: string,
): string | null {
  return headers.find((header) => header.name.toLowerCase() === name)?.value ?? null;
}

/** The toolbar data a response carries, or null when it has none (or only broken data). */
export function toolbarPayloadFromHeaders(
  headers: ReadonlyArray<{ readonly name: string; readonly value: string }>,
): ToolbarHeaderPayload | null {
  return decodeToolbarHeaders(
    headerValue(headers, "x-toolbar"),
    headerValue(headers, "x-toolbar-summary"),
  ) as ToolbarHeaderPayload | null;
}
