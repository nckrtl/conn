import type {
  CredentialApprovalRequest,
  CredentialField,
  ScopedThreadRef,
} from "@t3tools/contracts";

/** One agent request to fill a saved login, waiting for the user. */
export interface PendingCredentialApproval extends CredentialApprovalRequest {
  readonly id: number;
  readonly threadRef: ScopedThreadRef;
  /** The page's own name for the input, once the highlight found it. */
  readonly pageFieldLabel: string | null;
  readonly highlighted: boolean;
}

export interface CredentialApprovalAnswer {
  readonly approved: boolean;
  /** For a sign-in prompt: the fields the user allowed. */
  readonly fields?: ReadonlyArray<CredentialField>;
  readonly reason: "user" | "timeout";
}

interface QueuedApproval {
  readonly approval: PendingCredentialApproval;
  readonly resolve: (answer: CredentialApprovalAnswer) => void;
  readonly timer: ReturnType<typeof setTimeout>;
}

let nextId = 1;
let queue: ReadonlyArray<QueuedApproval> = [];
const listeners = new Set<() => void>();

const emit = () => {
  for (const listener of listeners) listener();
};

/**
 * Queues an approval prompt and resolves with the user's answer. Prompts show
 * one at a time, in order; an unanswered prompt counts as denied at `deadlineMs`.
 */
export function requestCredentialApproval(
  request: CredentialApprovalRequest,
  threadRef: ScopedThreadRef,
  deadlineMs: number,
): { readonly id: number; readonly answer: Promise<CredentialApprovalAnswer> } {
  const id = nextId++;
  const answer = new Promise<CredentialApprovalAnswer>((resolve) => {
    const approval: PendingCredentialApproval = {
      ...request,
      id,
      threadRef,
      pageFieldLabel: null,
      highlighted: false,
    };
    const timer = setTimeout(
      () => settle(id, { approved: false, reason: "timeout" }),
      Math.max(0, deadlineMs - Date.now()),
    );
    queue = [...queue, { approval, resolve, timer }];
    emit();
  });
  return { id, answer };
}

/** Adds what the page highlight learned to a waiting prompt. */
export function updateCredentialApproval(
  id: number,
  patch: Pick<PendingCredentialApproval, "pageFieldLabel" | "highlighted">,
): void {
  if (!queue.some((entry) => entry.approval.id === id)) return;
  queue = queue.map((entry) =>
    entry.approval.id === id ? { ...entry, approval: { ...entry.approval, ...patch } } : entry,
  );
  emit();
}

function settle(id: number, answer: CredentialApprovalAnswer): void {
  const entry = queue.find((candidate) => candidate.approval.id === id);
  if (!entry) return;
  clearTimeout(entry.timer);
  queue = queue.filter((candidate) => candidate !== entry);
  entry.resolve(answer);
  emit();
}

export function respondToCredentialApproval(
  id: number,
  approved: boolean,
  fields?: ReadonlyArray<CredentialField>,
): void {
  settle(id, { approved, reason: "user", ...(fields ? { fields } : {}) });
}

export function subscribeCredentialApprovals(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function readCurrentCredentialApproval(): PendingCredentialApproval | null {
  return queue[0]?.approval ?? null;
}

export const CREDENTIAL_FIELD_LABELS: Record<CredentialField, string> = {
  username: "username",
  password: "password",
  otp: "one-time code",
};

/** The origin of a URL, or null when it has none. */
export function originOf(url: string | null | undefined): string | null {
  if (!url) return null;
  try {
    const origin = new URL(url).origin;
    return origin === "null" ? null : origin;
  } catch {
    return null;
  }
}

/** The host shown in toasts and rows: the origin without its scheme. */
export function hostOf(origin: string): string {
  return origin.replace(/^https?:\/\//, "");
}
