import type { CredentialField, SiteCredentialOption } from "@t3tools/contracts";

import type { CredentialSubmitField } from "./credentialSubmit";
import type { CredentialPageFields } from "./credentialPageFields";

let nextSelectionId = 0;

const SIGN_IN_LIFETIME_MS = 2 * 60_000;

/** Metadata only, scoped to one tab and exact origin after an explicit choice. */
export interface CredentialContinuation {
  readonly id: string;
  readonly item: SiteCredentialOption;
  readonly tabId: string;
  readonly origin: string;
  readonly expiresAt: number;
  readonly pendingSubmit?: CredentialSubmitField | undefined;
  readonly attempted: ReadonlySet<CredentialField>;
}

export function beginCredentialContinuation(
  item: SiteCredentialOption,
  tabId: string,
  origin: string,
  fields: ReadonlyArray<CredentialField>,
  now = Date.now(),
): CredentialContinuation {
  return {
    id: `${now}:${++nextSelectionId}`,
    item,
    tabId,
    origin,
    expiresAt: now + SIGN_IN_LIFETIME_MS,
    attempted: new Set(fields),
  };
}

export function continuationMatches(
  session: CredentialContinuation,
  tabId: string,
  origin: string | null,
  now = Date.now(),
): boolean {
  return session.tabId === tabId && session.origin === origin && now < session.expiresAt;
}

/** Continue forward only. Never refill a rejected password/code or a user's existing input. */
export function continuationFields(
  session: CredentialContinuation,
  page: CredentialPageFields,
): ReadonlyArray<CredentialField> {
  if (page.password && !session.attempted.has("password") && page.empty.includes("password")) {
    return ["password"];
  }
  return page.otp && !session.attempted.has("otp") && page.empty.includes("otp") ? ["otp"] : [];
}
