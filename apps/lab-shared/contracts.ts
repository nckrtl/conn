// Local copies of the wire shapes the lab fixtures use, from packages/contracts (ipc.ts,
// orchestrationV2.ts). The labs are mocks: these never cross a wire.

export interface DesktopApiHeader {
  readonly name: string;
  readonly value: string;
}

export interface DesktopApiResponse {
  readonly error: string | null;
  readonly status: number;
  readonly statusText: string;
  readonly url: string;
  readonly headers: readonly DesktopApiHeader[];
  readonly body: string;
  readonly bodyEncoding: "text" | "base64";
  readonly size: number;
  readonly truncated: boolean;
  readonly durationMs: number;
}

export interface DesktopDatabaseConnection {
  readonly driver: "mysql" | "pgsql" | "sqlite";
  readonly host: string;
  readonly port: number | null;
  readonly database: string;
  readonly username: string;
  readonly password: string;
  readonly vaultItemId?: string;
}

export interface DesktopDatabaseRequest {
  readonly connection: DesktopDatabaseConnection;
  readonly allowUnlock?: boolean;
  readonly reconnect?: boolean;
  readonly operation: "tables" | "describe" | "query";
  readonly table?: string;
  readonly sql?: string;
}

export interface DesktopDatabaseColumn {
  readonly name: string;
  readonly type: string;
  readonly nullable: boolean;
  readonly default: string | null;
  readonly primary: boolean;
}

export interface DesktopDatabaseResponse {
  readonly error: string | null;
  readonly tables: readonly string[];
  readonly columns: readonly DesktopDatabaseColumn[];
  readonly resultColumns: readonly string[];
  readonly rows: ReadonlyArray<Readonly<Record<string, string | number | boolean | null>>>;
  readonly rowCount: number;
  readonly truncated: boolean;
  readonly durationMs: number;
}

/** One file of a turn's checkpoint summary. */
export interface TurnDiffFileChange {
  readonly path: string;
  readonly kind: string;
  readonly additions: number;
  readonly deletions: number;
}
