// @effect-diagnostics globalTimers:off - The Gateway client runs in the app, outside an Effect runtime.
import * as Schema from "effect/Schema";

/**
 * The Conn layer of the Orbit Gateway (`/api/v1/conn`, see Orbit's docs/reference/conn.md).
 *
 * The Gateway knows the caller by its WireGuard address, so a request carries no credentials. Each
 * app supplies the transport: the desktop main process (Electron `net.fetch`, which trusts the
 * Orbit root CA from the keychain and sends no `Origin`), or `fetch` on the phone.
 */

export const DEFAULT_ORBIT_GATEWAY_URL = "https://gateway.orbit";

export interface OrbitGatewayRequest {
  readonly method: "GET" | "POST" | "PUT" | "PATCH";
  /** A path below `/api/v1/conn`, such as `/me`. */
  readonly path: string;
  readonly body?: unknown;
  /** Overrides the transport's default limit for a call the Gateway answers slowly. */
  readonly timeoutMs?: number;
  /** Sent as `Idempotency-Key`: the same key and input return the same Operation. */
  readonly idempotencyKey?: string;
}

export interface OrbitGatewayResponse {
  readonly status: number;
  readonly body: string;
}

export type OrbitGatewayTransport = (request: OrbitGatewayRequest) => Promise<OrbitGatewayResponse>;

/** A failed Gateway call. `code` is the Gateway's error code, or `gateway.unreachable`/`gateway.response_invalid`. */
export class OrbitGatewayError extends Schema.TaggedError<OrbitGatewayError>()(
  "OrbitGatewayError",
  {
    code: Schema.String,
    message: Schema.String,
    status: Schema.Number,
    details: Schema.Record(Schema.String, Schema.Unknown),
  },
) {}

export interface OrbitGatewayProfile {
  readonly id: number;
  readonly name: string;
  readonly settingsVersion: number;
  readonly updatedAt: string;
}

export interface OrbitGatewayNode {
  readonly id: number;
  readonly name: string;
  readonly wireguardIp: string;
  readonly profile: OrbitGatewayProfile | null;
}

/** A workspace as the profile settings store it: the same shape as the desktop's workspace store. */
export interface OrbitGatewayWorkspace {
  readonly id: string;
  readonly name: string;
  readonly color: string;
  readonly icon: string | null;
  readonly image?: string | null;
  readonly projectRefs?: readonly string[];
  readonly projectKeys?: readonly string[];
}

/** Who changed one section of a profile, and when. */
export interface OrbitGatewaySectionMeta {
  readonly version: number;
  readonly updatedAt: string | null;
  readonly updatedBy: string | null;
}

export interface OrbitGatewaySettings {
  readonly profileId: number;
  readonly version: number;
  readonly workspaces: readonly OrbitGatewayWorkspace[];
  readonly updatedAt: string;
  /** The whole settings document as sent, so sections this client does not know stay readable. */
  readonly document: Readonly<Record<string, unknown>>;
  /**
   * Version, time and author of each section the Gateway has written, or null from a Gateway
   * that predates sections (it also cannot PATCH).
   */
  readonly sections: Readonly<Record<string, OrbitGatewaySectionMeta>> | null;
}

/** One section in a PATCH: the version this device last read (0 = never written) and the new value (null clears it). */
export interface OrbitGatewaySectionPatch {
  readonly version: number;
  readonly value: Readonly<Record<string, unknown>> | null;
}

export interface OrbitGatewayEnvironment {
  readonly environmentId: string;
  readonly label: string;
  readonly url: string;
  readonly serverVersion: string | null;
  readonly registeredBy: string | null;
  /** When the server last registered. A refused pairing waits for the next registration. */
  readonly registeredAt: string | null;
  readonly status: "registered" | "session_expired";
  /** The container Instance whose T3 server this is, or null for a server that registered itself. */
  readonly instanceId: number | null;
  /** The Instance container's power state; `stopped` means the Instance is asleep. */
  readonly powerState: "running" | "stopped" | null;
  /** Conn: the clone's Orbit Project, Instance, Node and URL; null on host servers or when not sent. */
  readonly projectId: number | null;
  readonly projectName: string | null;
  readonly projectSlug: string | null;
  readonly instanceName: string | null;
  readonly nodeName: string | null;
  readonly instanceUrl: string | null;
}

/** A Project a thread can start in: its default Instance runs in a container on `nodeName`. */
export interface OrbitGatewayProject {
  readonly id: number;
  readonly slug: string;
  readonly name: string;
  readonly nodeId: number;
  readonly nodeName: string;
}

/** The fields of an Orbit Operation that Conn follows. */
export interface OrbitGatewayOperation {
  readonly id: number;
  readonly kind: string;
  readonly status:
    | "queued"
    | "running"
    | "waiting"
    | "succeeded"
    | "failed"
    | "cancelled"
    | "interrupted";
  readonly targetId: number;
  readonly errorCode: string | null;
  /** Seconds to wait before the next read, or null once the Operation ended. */
  readonly pollAfterSeconds: number | null;
  /**
   * Step progress. Present only when the Gateway sends it; an Operation without it parses as
   * before, and a malformed step is dropped.
   */
  readonly steps?: readonly OrbitGatewayOperationStep[];
  readonly currentStep?: string | null;
  readonly currentStepStartedAt?: string | null;
  readonly failedStep?: string | null;
  readonly error?: OrbitGatewayOperationError | null;
  readonly result?: Readonly<Record<string, unknown>> | null;
}

export interface OrbitGatewayOperationError {
  readonly code: string | null;
  readonly message: string | null;
}

/** One step of an Operation. `status` is the Gateway's own word; unknown values pass through. */
export interface OrbitGatewayOperationStep {
  readonly name: string;
  readonly job: string | null;
  readonly status: string;
  readonly startedAt: string | null;
  readonly finishedAt: string | null;
}

export const OPERATION_TERMINAL_STATUSES: ReadonlySet<OrbitGatewayOperation["status"]> = new Set([
  "succeeded",
  "failed",
  "cancelled",
  "interrupted",
]);

export interface OrbitGatewayPairing {
  readonly environmentId: string;
  readonly pairingUrl: string;
  readonly expiresAt: string;
}

export interface OrbitGatewayClient {
  readonly me: () => Promise<OrbitGatewayNode>;
  readonly profiles: () => Promise<readonly OrbitGatewayProfile[]>;
  readonly createProfile: (name: string) => Promise<OrbitGatewayProfile>;
  readonly bindProfile: (profileId: number) => Promise<OrbitGatewayNode>;
  readonly settings: (profileId: number) => Promise<OrbitGatewaySettings>;
  /** Replaces the workspaces. A stale `version` fails with `conn.settings_version_conflict`. */
  readonly replaceWorkspaces: (
    profileId: number,
    version: number,
    workspaces: readonly OrbitGatewayWorkspace[],
  ) => Promise<OrbitGatewaySettings>;
  /**
   * Writes the given sections in one all-or-nothing request. A stale section version fails the
   * whole request with `conn.settings_version_conflict`; an older Gateway answers 404 or 405.
   */
  readonly patchSections: (
    profileId: number,
    sections: Readonly<Record<string, OrbitGatewaySectionPatch>>,
  ) => Promise<OrbitGatewaySettings>;
  readonly environments: () => Promise<readonly OrbitGatewayEnvironment[]>;
  /**
   * Mints a one-time pairing link to the server for this device. The Gateway mints it in an
   * Operation; this follows the Operation and reads the link, which the Gateway hands out once.
   */
  readonly pair: (environmentId: string) => Promise<OrbitGatewayPairing>;
  /** The Projects a thread can start in. */
  readonly projects: () => Promise<readonly OrbitGatewayProject[]>;
  /**
   * Admits the clone a thread starts in; the Operation's `targetId` is the new Instance. The
   * Gateway admits it slowly, so the call has a 60 s limit; the same key returns the same Operation.
   */
  readonly createThreadInstance: (
    projectId: number,
    name: string,
    idempotencyKey: string,
  ) => Promise<OrbitGatewayOperation>;
  /** Reads an Operation this device started through the Conn layer. */
  readonly operation: (operationId: number) => Promise<OrbitGatewayOperation>;
  /**
   * Admits a pairing with the server; the Operation's `targetId` is the pairing. Admission copies
   * a secret to Swamp, so it has the create's limit; the same key returns the same Operation.
   */
  readonly startPairing: (
    environmentId: string,
    idempotencyKey: string,
  ) => Promise<OrbitGatewayOperation>;
  /** Reads the link of a pairing whose Operation succeeded. The Gateway hands it out once. */
  readonly readPairing: (environmentId: string, pairingId: number) => Promise<OrbitGatewayPairing>;
}

export const SETTINGS_VERSION_CONFLICT = "conn.settings_version_conflict";

/** How long `pair` follows the Gateway's Operation, and the bounds of its poll interval. */
export const OPERATION_TIMEOUT_MS = 60_000;
/** The Gateway copies secrets to Swamp before it admits a create or a pairing: 19-27 s today. */
const ADMISSION_TIMEOUT_MS = 60_000;
const MIN_POLL_MS = 500;
const MAX_POLL_MS = 15_000;

/** The wait before the next read of an Operation: the Gateway's interval, kept between 0.5 and 15 s. */
export function operationPollDelayMs(pollAfterSeconds: number | null): number {
  return Math.min(Math.max((pollAfterSeconds ?? 0) * 1000, MIN_POLL_MS), MAX_POLL_MS);
}
/** Operation statuses that are not final yet; every other status ends the Operation. */
const OPEN_OPERATION_STATUSES: ReadonlySet<string> = new Set(["queued", "running", "waiting"]);

/**
 * Pairing error codes that the Gateway calls final: T3 answered and refused. Callers must not
 * retry them on their own (Orbit docs/reference/conn.md, "Pairing Operations").
 */
const FINAL_PAIRING_ERROR_CODES: ReadonlySet<string> = new Set([
  "conn.session_rejected",
  "conn.request_refused",
  "conn.response_invalid",
]);

export interface OrbitGatewayClientOptions {
  /** Waits between Operation polls. Tests replace it. */
  readonly sleep?: (ms: number) => Promise<void>;
  readonly now?: () => number;
}

export function createOrbitGatewayClient(
  transport: OrbitGatewayTransport,
  options: OrbitGatewayClientOptions = {},
): OrbitGatewayClient {
  const sleep =
    options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const now = options.now ?? Date.now;
  const call = async (request: OrbitGatewayRequest): Promise<unknown> => {
    let response: OrbitGatewayResponse;
    try {
      response = await transport(request);
    } catch (cause) {
      throw new OrbitGatewayError({
        code: "gateway.unreachable",
        message: `The Orbit Gateway did not answer: ${cause instanceof Error ? cause.message : String(cause)}`,
        status: 0,
        details: {},
      });
    }
    const json = parseJson(response.body);
    if (response.status < 200 || response.status >= 300) {
      const error = record(record(json)?.error);
      throw new OrbitGatewayError({
        code: typeof error?.code === "string" ? error.code : "gateway.request_failed",
        message:
          typeof error?.message === "string"
            ? error.message
            : `The Orbit Gateway answered ${response.status}.`,
        status: response.status,
        details: record(error?.details) ?? {},
      });
    }
    const envelope = record(json);
    if (!envelope || !("data" in envelope)) {
      throw invalid(request.path);
    }
    return envelope.data;
  };

  /** Polls a Conn Operation until it ends, and returns it when it succeeded. */
  const settle = async (
    started: Record<string, unknown> | null,
    path: string,
  ): Promise<Record<string, unknown>> => {
    let operation = started;
    const deadline = now() + OPERATION_TIMEOUT_MS;
    for (;;) {
      if (typeof operation?.id !== "number" || typeof operation.status !== "string") {
        throw invalid(path);
      }
      if (operation.status === "succeeded") return operation;
      if (!OPEN_OPERATION_STATUSES.has(operation.status)) {
        throw new OrbitGatewayError({
          code:
            typeof operation.error_code === "string" ? operation.error_code : "operation.failed",
          message: `The Orbit Gateway could not finish ${path}: the Operation ${operation.status}.`,
          status: 0,
          details: { operation_id: operation.id },
        });
      }
      if (now() >= deadline) {
        throw new OrbitGatewayError({
          code: "operation.timeout",
          message: `The Orbit Gateway did not finish ${path} in time.`,
          status: 0,
          details: { operation_id: operation.id },
        });
      }
      const wait = operationPollDelayMs(
        typeof operation.poll_after_seconds === "number" ? operation.poll_after_seconds : null,
      );
      await sleep(Math.max(Math.min(wait, deadline - now()), 0));
      operation = record(await call({ method: "GET", path: `/operations/${operation.id}` }));
    }
  };

  return {
    me: async () => node(await call({ method: "GET", path: "/me" }), "/me"),
    profiles: async () =>
      list(await call({ method: "GET", path: "/profiles" }), "/profiles", profile),
    createProfile: async (name) =>
      profile(await call({ method: "POST", path: "/profiles", body: { name } }), "/profiles"),
    bindProfile: async (profileId) =>
      node(
        await call({ method: "PUT", path: "/me/profile", body: { profile_id: profileId } }),
        "/me/profile",
      ),
    settings: async (profileId) =>
      settings(
        await call({ method: "GET", path: `/profiles/${profileId}/settings` }),
        "/profiles/settings",
      ),
    replaceWorkspaces: async (profileId, version, workspaces) =>
      settings(
        await call({
          method: "PUT",
          path: `/profiles/${profileId}/settings`,
          body: { version, settings: { workspaces: workspaces.map(toWire) } },
        }),
        "/profiles/settings",
      ),
    patchSections: async (profileId, sections) =>
      settings(
        await call({
          method: "PATCH",
          path: `/profiles/${profileId}/settings`,
          body: { sections },
        }),
        "/profiles/settings",
      ),
    environments: async () =>
      list(await call({ method: "GET", path: "/environments" }), "/environments", environment),
    pair: async (environmentId) => {
      const path = `/environments/${encodeURIComponent(environmentId)}/pairings`;
      let data = record(await call({ method: "POST", path, timeoutMs: ADMISSION_TIMEOUT_MS }));
      // The Gateway mints the link in an Operation (202). Follow it, then read the link once.
      if (typeof data?.pairing_url !== "string") {
        const result = record((await settle(data, path)).result);
        if (typeof result?.pairing_id !== "number") throw invalid(path);
        data = record(await call({ method: "GET", path: `${path}/${result.pairing_id}` }));
      }
      return issuedPairing(data, path);
    },
    projects: async () =>
      list(await call({ method: "GET", path: "/projects" }), "/projects", project),
    createThreadInstance: async (projectId, name, idempotencyKey) => {
      const path = `/projects/${projectId}/instances`;
      return operation(
        await call({
          method: "POST",
          path,
          body: { name },
          timeoutMs: ADMISSION_TIMEOUT_MS,
          idempotencyKey,
        }),
        path,
      );
    },
    operation: async (operationId) => {
      const path = `/operations/${operationId}`;
      return operation(await call({ method: "GET", path }), path);
    },
    startPairing: async (environmentId, idempotencyKey) => {
      const path = `/environments/${encodeURIComponent(environmentId)}/pairings`;
      return operation(
        await call({ method: "POST", path, timeoutMs: ADMISSION_TIMEOUT_MS, idempotencyKey }),
        path,
      );
    },
    readPairing: async (environmentId, pairingId) => {
      const path = `/environments/${encodeURIComponent(environmentId)}/pairings/${pairingId}`;
      return issuedPairing(await call({ method: "GET", path }), path);
    },
  };
}

function issuedPairing(value: unknown, path: string): OrbitGatewayPairing {
  const data = record(value);
  const pairing = record(data?.pairing);
  if (
    typeof data?.pairing_url !== "string" ||
    typeof pairing?.environment_id !== "string" ||
    typeof pairing.expires_at !== "string"
  ) {
    throw invalid(path);
  }
  return {
    environmentId: pairing.environment_id,
    pairingUrl: data.pairing_url,
    expiresAt: pairing.expires_at,
  };
}

const OPERATION_STATUSES: ReadonlySet<string> = new Set([
  "queued",
  "running",
  "waiting",
  ...OPERATION_TERMINAL_STATUSES,
]);

function operation(value: unknown, path: string): OrbitGatewayOperation {
  const data = record(value);
  if (
    typeof data?.id !== "number" ||
    typeof data.kind !== "string" ||
    typeof data.status !== "string" ||
    !OPERATION_STATUSES.has(data.status) ||
    typeof data.target_id !== "number"
  ) {
    throw invalid(path);
  }
  return {
    id: data.id,
    kind: data.kind,
    status: data.status as OrbitGatewayOperation["status"],
    targetId: data.target_id,
    errorCode: typeof data.error_code === "string" ? data.error_code : null,
    pollAfterSeconds: typeof data.poll_after_seconds === "number" ? data.poll_after_seconds : null,
    ...(Array.isArray(data.steps) ? { steps: data.steps.flatMap(operationStep) } : {}),
    ...("current_step" in data ? { currentStep: optionalText(data.current_step) } : {}),
    ...("current_step_started_at" in data
      ? { currentStepStartedAt: optionalText(data.current_step_started_at) }
      : {}),
    ...("failed_step" in data ? { failedStep: optionalText(data.failed_step) } : {}),
    ...("error" in data ? { error: operationError(data.error) } : {}),
    ...("result" in data ? { result: record(data.result) } : {}),
  };
}

function operationStep(value: unknown): OrbitGatewayOperationStep[] {
  const data = record(value);
  const name = optionalText(data?.name);
  const status = optionalText(data?.status);
  if (name === null || status === null) return [];
  return [
    {
      name,
      job: optionalText(data?.job),
      status,
      startedAt: optionalText(data?.started_at),
      finishedAt: optionalText(data?.finished_at),
    },
  ];
}

/** The Operation's error: an object with a code and a message, or a bare message. */
function operationError(value: unknown): OrbitGatewayOperationError | null {
  if (typeof value === "string") return { code: null, message: gatewayText(value) };
  const data = record(value);
  if (data === null) return null;
  return { code: optionalText(data.code), message: optionalText(data.message) };
}

function project(value: unknown, path: string): OrbitGatewayProject {
  const data = record(value);
  if (
    typeof data?.id !== "number" ||
    typeof data.slug !== "string" ||
    typeof data.name !== "string" ||
    typeof data.node_id !== "number" ||
    typeof data.node_name !== "string"
  ) {
    throw invalid(path);
  }
  return {
    id: data.id,
    slug: data.slug,
    name: data.name,
    nodeId: data.node_id,
    nodeName: data.node_name,
  };
}

/** Whether a `pair` failure is one the Gateway calls final, so the caller must not retry it. */
export function isFinalPairingError(error: unknown): boolean {
  return isOrbitGatewayError(error) && FINAL_PAIRING_ERROR_CODES.has(error.code);
}

const isOrbitGatewayError = Schema.is(OrbitGatewayError);

/** A string the way the Gateway stores it: trimmed, and null when nothing is left. */
export function gatewayText(value: string | null | undefined): string | null {
  const trimmed = value?.trim();
  return trimmed ? trimmed : null;
}

function gatewayTexts(values: readonly string[] | undefined): string[] {
  return (values ?? []).flatMap((value) => gatewayText(value) ?? []);
}

/**
 * The wire form of a workspace: only the keys the Gateway accepts, with strings as it stores
 * them (an empty icon or image is null), so a read-back equals what was sent.
 */
function toWire(workspace: OrbitGatewayWorkspace): OrbitGatewayWorkspace {
  return {
    id: workspace.id.trim(),
    name: workspace.name.trim(),
    color: workspace.color.trim(),
    icon: gatewayText(workspace.icon),
    image: gatewayText(workspace.image),
    projectRefs: gatewayTexts(workspace.projectRefs),
    projectKeys: gatewayTexts(workspace.projectKeys),
  };
}

function parseJson(body: string): unknown {
  try {
    return JSON.parse(body);
  } catch {
    return null;
  }
}

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function invalid(path: string): OrbitGatewayError {
  return new OrbitGatewayError({
    code: "gateway.response_invalid",
    message: `The Orbit Gateway sent an unexpected ${path} response.`,
    status: 0,
    details: {},
  });
}

function list<T>(value: unknown, path: string, item: (value: unknown, path: string) => T): T[] {
  if (!Array.isArray(value)) throw invalid(path);
  return value.map((entry) => item(entry, path));
}

function profile(value: unknown, path: string): OrbitGatewayProfile {
  const data = record(value);
  if (
    typeof data?.id !== "number" ||
    typeof data.name !== "string" ||
    typeof data.settings_version !== "number" ||
    typeof data.updated_at !== "string"
  ) {
    throw invalid(path);
  }
  return {
    id: data.id,
    name: data.name,
    settingsVersion: data.settings_version,
    updatedAt: data.updated_at,
  };
}

function node(value: unknown, path: string): OrbitGatewayNode {
  const data = record(value);
  if (
    typeof data?.id !== "number" ||
    typeof data.name !== "string" ||
    typeof data.wireguard_ip !== "string"
  ) {
    throw invalid(path);
  }
  return {
    id: data.id,
    name: data.name,
    wireguardIp: data.wireguard_ip,
    profile:
      data.profile === null || data.profile === undefined ? null : profile(data.profile, path),
  };
}

function settings(value: unknown, path: string): OrbitGatewaySettings {
  const data = record(value);
  const document = record(data?.settings);
  const workspaces = document?.workspaces;
  if (
    document === null ||
    typeof data?.profile_id !== "number" ||
    typeof data.version !== "number" ||
    typeof data.updated_at !== "string" ||
    !Array.isArray(workspaces)
  ) {
    throw invalid(path);
  }
  return {
    profileId: data.profile_id,
    version: data.version,
    updatedAt: data.updated_at,
    workspaces: workspaces.map((entry) => workspace(entry, path)),
    document,
    sections: sectionMetas(data.sections),
  };
}

function sectionMetas(value: unknown): Record<string, OrbitGatewaySectionMeta> | null {
  const data = record(value);
  if (data === null) return null;
  const sections: Record<string, OrbitGatewaySectionMeta> = {};
  for (const [name, entry] of Object.entries(data)) {
    const meta = record(entry);
    if (typeof meta?.version !== "number") continue;
    const by = meta.updated_by;
    sections[name] = {
      version: meta.version,
      updatedAt: typeof meta.updated_at === "string" ? meta.updated_at : null,
      updatedBy:
        typeof by === "string"
          ? by
          : typeof record(by)?.name === "string"
            ? (record(by)!.name as string)
            : null,
    };
  }
  return sections;
}

function strings(value: unknown, path: string): string[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== "string")) {
    throw invalid(path);
  }
  return value as string[];
}

function workspace(value: unknown, path: string): OrbitGatewayWorkspace {
  const data = record(value);
  if (
    typeof data?.id !== "string" ||
    typeof data.name !== "string" ||
    typeof data.color !== "string" ||
    (data.icon !== null && typeof data.icon !== "string") ||
    (data.image !== undefined && data.image !== null && typeof data.image !== "string")
  ) {
    throw invalid(path);
  }
  const projectRefs = strings(data.projectRefs, path);
  const projectKeys = strings(data.projectKeys, path);
  return {
    id: data.id,
    name: data.name,
    color: data.color,
    icon: data.icon as string | null,
    image: (data.image as string | null | undefined) ?? null,
    ...(projectRefs ? { projectRefs } : {}),
    ...(projectKeys ? { projectKeys } : {}),
  };
}

function environment(value: unknown, path: string): OrbitGatewayEnvironment {
  const data = record(value);
  if (
    typeof data?.environment_id !== "string" ||
    typeof data.label !== "string" ||
    typeof data.url !== "string" ||
    (data.status !== "registered" && data.status !== "session_expired")
  ) {
    throw invalid(path);
  }
  return {
    environmentId: data.environment_id,
    label: data.label,
    url: data.url,
    serverVersion: typeof data.server_version === "string" ? data.server_version : null,
    registeredBy: typeof data.registered_by === "string" ? data.registered_by : null,
    registeredAt: typeof data.registered_at === "string" ? data.registered_at : null,
    status: data.status,
    instanceId: typeof data.instance_id === "number" ? data.instance_id : null,
    powerState:
      data.power_state === "running" || data.power_state === "stopped" ? data.power_state : null,
    projectId: typeof data.project_id === "number" ? data.project_id : null,
    projectName: optionalText(data.project_name),
    projectSlug: optionalText(data.project_slug),
    instanceName: optionalText(data.instance_name),
    nodeName: optionalText(data.node_name),
    instanceUrl: optionalText(data.instance_url),
  };
}

/** A trimmed string, or null for anything else (absent, empty or another type). */
function optionalText(value: unknown): string | null {
  return typeof value === "string" ? gatewayText(value) : null;
}
