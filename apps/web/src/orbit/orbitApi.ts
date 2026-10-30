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

function parseOrbitInstance(value: unknown): OrbitInstance {
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

interface RegistrationOperation {
  readonly id: number;
  readonly targetId: number;
  readonly status: string;
  readonly sequence: number;
  readonly pollAfterSeconds: number | null;
  readonly errorCode: string | null;
  readonly failedStep: string | null;
}

function registrationOperation(value: unknown): RegistrationOperation {
  const data = record(value);
  const id = int(data?.id);
  const targetId = int(data?.target_id);
  const sequence = int(data?.sequence);
  const status = text(data?.status);
  const pollAfterSeconds = int(data?.poll_after_seconds);
  if (
    id === null ||
    id < 1 ||
    targetId === null ||
    targetId < 1 ||
    sequence === null ||
    sequence < 1 ||
    data?.kind !== "instance.register" ||
    data?.target_type !== "instance" ||
    !status ||
    !["queued", "running", "waiting", "succeeded", "failed", "cancelled"].includes(status) ||
    (["queued", "running", "waiting"].includes(status) &&
      (pollAfterSeconds === null || pollAfterSeconds < 1))
  ) {
    throw malformed("registration Operation");
  }
  return {
    id,
    targetId,
    status,
    sequence,
    pollAfterSeconds,
    errorCode: text(data?.error_code),
    failedStep: text(data?.failed_step),
  };
}

/**
 * Register the existing worktree once. The documented 202 reply is an Operation;
 * follow it through setup, then read its Instance. Stop waiting after 30 minutes
 * without cancelling or repeating the admitted registration.
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
  const deadline = Date.now() + 30 * 60 * 1000;
  const admitted = registrationOperation(
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
      timeoutSeconds: 30 * 60,
    }),
  );
  let operation = admitted;
  const pending = () =>
    new OrbitApiError(
      "orbit.operation_pending",
      `Orbit registration Operation ${admitted.id} is still pending. Inspect that Operation before registering again.`,
      504,
    );
  while (["queued", "running", "waiting"].includes(operation.status)) {
    const remaining = deadline - Date.now();
    if (remaining <= 0) throw pending();
    await new Promise<void>((resolve) =>
      setTimeout(resolve, Math.min(operation.pollAfterSeconds! * 1000, remaining)),
    );
    if (Date.now() >= deadline) throw pending();
    operation = registrationOperation(
      await callOrbit(transport, {
        method: "GET",
        path: `/api/v1/operations/${admitted.id}`,
        query: { after_sequence: String(operation.sequence) },
        timeoutSeconds: Math.max(1, Math.ceil((deadline - Date.now()) / 1000)),
      }),
    );
    if (operation.id !== admitted.id || operation.targetId !== admitted.targetId) {
      throw malformed("registration Operation");
    }
  }
  if (operation.status !== "succeeded") {
    throw new OrbitApiError(
      operation.errorCode ?? `operation.${operation.status}`,
      `Orbit registration Operation ${operation.id} ${operation.status}${operation.failedStep ? ` at ${operation.failedStep}` : ""}.`,
      200,
    );
  }
  const instance = parseOrbitInstance(
    await callOrbit(transport, {
      method: "GET",
      path: `/api/v1/instances/${admitted.targetId}`,
    }),
  );
  if (instance.id !== admitted.targetId) throw malformed("Instance");
  return instance;
}
