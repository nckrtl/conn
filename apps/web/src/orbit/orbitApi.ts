import * as Schema from "effect/Schema";

import type { OrbitHttpRequest, OrbitHttpResponse, OrbitTransport } from "./orbitTransport";

/**
 * The few Orbit Gateway calls T3 makes. Shapes follow the live API.
 */

export interface OrbitNode {
  readonly id: number;
  readonly name: string;
  readonly roles: ReadonlyArray<string>;
  readonly tld: string | null;
  /** Root of Orbit's managed checkouts on the Node, e.g. `/fast/apps`. */
  readonly appsPath: string | null;
  readonly wireguardIp: string | null;
}

export class OrbitApiError extends Schema.TaggedError<OrbitApiError>()("OrbitApiError", {
  code: Schema.String,
  message: Schema.String,
  status: Schema.Number,
}) {}

export const isOrbitApiError = Schema.is(OrbitApiError);

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
  throw new OrbitApiError({
    code: text(error?.code) ?? `http.${response.status}`,
    message: text(error?.message) ?? `Orbit answered with HTTP ${response.status}.`,
    status: response.status,
  });
}

function malformed(what: string): OrbitApiError {
  return new OrbitApiError({
    code: "orbit.response_invalid",
    message: `Orbit sent an invalid ${what}.`,
    status: 200,
  });
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
