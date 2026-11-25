import { type ApiRequestDraft, type ApiResponse, type ToolbarFixture, respond } from "./apiFixture";

export interface ToolbarCapture {
  readonly method: string;
  readonly uri: string;
  readonly status: number;
  readonly durationMs: number;
  readonly data: ToolbarFixture;
}

interface Result {
  readonly response: ApiResponse | null;
  readonly sending: boolean;
}

interface Snapshot {
  readonly results: Readonly<Record<string, Result>>;
  readonly history: readonly ToolbarCapture[];
  readonly selectedCapture: ToolbarCapture | null;
}

// Results and captures live for the browser session. Only the editor drafts go to disk.
class ApiSession {
  private state: Snapshot = { results: {}, history: [], selectedCapture: null };
  private listeners = new Set<() => void>();
  private pending = new Map<string, number>();

  snapshot = () => this.state;
  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  private update(patch: Partial<Snapshot>) {
    this.state = { ...this.state, ...patch };
    for (const notify of this.listeners) notify();
  }

  selectCapture = (selectedCapture: ToolbarCapture) => this.update({ selectedCapture });
  clearHistory = () =>
    this.update({ history: this.state.history.slice(-1), selectedCapture: null });

  remove(id: string) {
    window.clearTimeout(this.pending.get(id));
    this.pending.delete(id);
    const { [id]: _removed, ...results } = this.state.results;
    this.update({ results });
  }

  send(request: ApiRequestDraft) {
    const { id } = request;
    if (!request.url.trim() || this.pending.has(id)) return;
    const response = respond(request);
    const delay = response.error ? 250 : Math.min(Math.max(response.durationMs, 220), 700);
    const timer = window.setTimeout(() => {
      this.pending.delete(id);
      const results = { ...this.state.results, [id]: { response, sending: false } };
      if (!response.toolbar) {
        this.update({ results });
        return;
      }
      const url = new URL(response.url);
      const capture = {
        method: request.method,
        uri: url.pathname + url.search,
        status: response.status,
        durationMs: response.durationMs,
        data: response.toolbar,
      };
      // T3 keeps the latest 200 captures and selects each newly captured request.
      this.update({
        results,
        history: [...this.state.history.slice(-199), capture],
        selectedCapture: null,
      });
    }, delay);
    this.pending.set(id, timer);
    this.update({
      results: {
        ...this.state.results,
        [id]: { response: this.state.results[id]?.response ?? null, sending: true },
      },
    });
  }
}

const sessions = new Map<string, ApiSession>();

export function projectApiSession(key: string) {
  let session = sessions.get(key);
  if (!session) {
    session = new ApiSession();
    sessions.set(key, session);
  }
  return session;
}
