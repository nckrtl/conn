import type { OrbitHttpRequest, OrbitHttpResponse, OrbitTransport } from "./orbitTransport";

/**
 * The few Orbit Gateway calls T3 makes. Shapes follow the live API.
 */

export interface OrbitInstance {
  readonly id: number;
  readonly name: string;
  readonly projectId: number;
  readonly projectSlug: string | null;
  readonly nodeId: number;
  readonly checkoutPath: string;
  readonly branch: string | null;
  readonly domain: string | null;
  readonly url: string | null;
  readonly status: string;
}

export interface OrbitNode {
  readonly id: number;
  readonly name: string;
  readonly roles: ReadonlyArray<string>;
  readonly tld: string | null;
  /** Root of Orbit's managed checkouts on the Node, e.g. `/fast/apps`. */
  readonly appsPath: string | null;
  readonly wireguardIp: string | null;
}

export class OrbitApiError extends Error {
  override readonly name = "OrbitApiError";
  constructor(
    readonly code: string,
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function text(value: unknown): string | null {
  return typeof value === "string" && value.trim() !== "" ? value : null;
}

function int(value: unknown): number | null {
  return typeof value === "number" && Number.isInteger(value) ? value : null;
}

/** One Gateway call; returns `data`, or throws the API error. */
export async function callOrbit(
  transport: OrbitTransport,
  request: OrbitHttpRequest,
): Promise<unknown> {
  const response: OrbitHttpResponse = await transport(request);
  const body = record(response.body);
  if (response.status >= 200 && response.status < 300) {
    return body?.data ?? null;
  }
  const error = record(body?.error);
  throw new OrbitApiError(
    text(error?.code) ?? `http.${response.status}`,
    text(error?.message) ?? `Orbit answered with HTTP ${response.status}.`,
    response.status,
  );
}

function malformed(what: string): OrbitApiError {
  return new OrbitApiError("orbit.response_invalid", `Orbit sent an invalid ${what}.`, 200);
}

export function parseOrbitInstance(value: unknown): OrbitInstance {
  const data = record(value);
  const id = int(data?.id);
  const projectId = int(data?.project_id);
  const nodeId = int(data?.node_id);
  const checkoutPath = text(data?.checkout_path);
  const name = text(data?.name);
  if (id === null || projectId === null || nodeId === null || !checkoutPath || !name) {
    throw malformed("Instance");
  }
  const route = record(data?.route);
  return {
    id,
    name,
    projectId,
    projectSlug: text(record(data?.project)?.slug),
    nodeId,
    checkoutPath,
    branch: text(data?.branch_override) ?? text(data?.selected_branch),
    domain: text(data?.domain) ?? text(route?.domain),
    url: text(data?.url),
    status: text(data?.status) ?? "unknown",
  };
}

export interface OrbitProject {
  readonly id: number;
  readonly slug: string;
  readonly repositoryUrl: string | null;
  readonly defaultBranch: string | null;
}

export interface OrbitInstanceSummary {
  readonly id: number;
  readonly name: string;
  readonly projectId: number;
  readonly nodeId: number;
  readonly status: string;
  readonly checkoutPath: string | null;
}

async function list(transport: OrbitTransport, path: string): Promise<unknown[]> {
  const data = await callOrbit(transport, { method: "GET", path });
  if (!Array.isArray(data)) throw malformed("list");
  return data;
}

export async function listOrbitProjects(transport: OrbitTransport): Promise<OrbitProject[]> {
  return (await list(transport, "/api/v1/projects")).flatMap((value) => {
    const data = record(value);
    const id = int(data?.id);
    const slug = text(data?.slug);
    return id === null || !slug
      ? []
      : [
          {
            id,
            slug,
            repositoryUrl: text(data?.repository_url),
            defaultBranch: text(data?.default_branch),
          },
        ];
  });
}

export async function listOrbitNodes(transport: OrbitTransport): Promise<OrbitNode[]> {
  return (await list(transport, "/api/v1/nodes")).flatMap((value) => {
    const data = record(value);
    const id = int(data?.id);
    const name = text(data?.name);
    if (id === null || !name) return [];
    const roles = Array.isArray(data?.roles)
      ? data.roles.filter((role): role is string => typeof role === "string")
      : [];
    return [
      {
        id,
        name,
        roles,
        tld: text(data?.tld),
        appsPath: text(record(record(data?.settings)?.apps)?.path),
        wireguardIp: text(data?.wireguard_ip),
      },
    ];
  });
}

export async function listOrbitInstances(
  transport: OrbitTransport,
): Promise<OrbitInstanceSummary[]> {
  return (await list(transport, "/api/v1/instances")).flatMap((value) => {
    const data = record(value);
    const id = int(data?.id);
    const name = text(data?.name);
    const projectId = int(data?.project_id);
    const nodeId = int(data?.node_id);
    if (id === null || !name || projectId === null || nodeId === null) return [];
    return [
      {
        id,
        name,
        projectId,
        nodeId,
        status: text(data?.status) ?? "unknown",
        checkoutPath: text(data?.checkout_path),
      },
    ];
  });
}

/**
 * `instance:register`: adopt a checkout or linked worktree that already sits in
 * Orbit's managed path (`<apps-root>/<project-slug>/<name>`), so Orbit does not
 * move it. With `setup`, Orbit runs the Project setup steps before it answers.
 */
export async function registerOrbitInstance(
  transport: OrbitTransport,
  input: {
    readonly sourcePath: string;
    readonly projectId: number;
    readonly instanceName: string;
    readonly domain: string;
  },
): Promise<OrbitInstance> {
  const data = record(
    await callOrbit(transport, {
      method: "POST",
      path: "/api/v1/instances/register",
      body: {
        source_path: input.sourcePath,
        project_id: input.projectId,
        instance_name: input.instanceName,
        domain: input.domain,
        setup: true,
      },
      // Adoption, dependency copy and the Project setup steps; Orbit's own deadline applies too.
      timeoutSeconds: 30 * 60,
    }),
  );
  return parseOrbitInstance(data?.instance);
}
