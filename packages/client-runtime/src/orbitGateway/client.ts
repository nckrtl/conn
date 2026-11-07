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
  readonly status: "registered" | "session_expired";
}

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
  /** Mints a one-time pairing link to the server for this device. */
  readonly pair: (environmentId: string) => Promise<OrbitGatewayPairing>;
}

export const SETTINGS_VERSION_CONFLICT = "conn.settings_version_conflict";

export function createOrbitGatewayClient(transport: OrbitGatewayTransport): OrbitGatewayClient {
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
      const data = record(await call({ method: "POST", path }));
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
    },
  };
}

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
    status: data.status,
  };
}
