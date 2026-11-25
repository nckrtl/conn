import { TASK_LANES, TASKS } from "../../../lab-ios/src/data/fixtures";

let nextId = 0;
export function fixtureId() {
  return "mcp-lab-" + ++nextId;
}

export const protocol = "2025-06-18";
export const demoUrl = "https://orbit.example/mcp";
export const demoCommand = "orbit mcp serve";
export const serverInfo = { name: "orbit", title: "Orbit", version: "1.0.0" };

export type Catalog = "Tools" | "Resources" | "Prompts";
export type Transport = "HTTP" | "STDIO" | "SSE";
type InputValue = string | number | boolean | null | readonly InputValue[] | InputObject;
type InputObject = { readonly [key: string]: InputValue };

export interface InputSchemaProperty {
  type: "string" | "array" | "integer" | "boolean";
  description: string;
  examples?: readonly InputValue[];
  default?: InputValue;
  enum?: readonly string[];
  items?: { type: "string"; enum?: readonly string[] };
  minimum?: number;
  maximum?: number;
}

export interface InputSchema {
  type: "object";
  description: string;
  properties: Record<string, InputSchemaProperty>;
  required?: readonly string[];
  examples?: readonly InputObject[];
}

export interface ToolAnnotations {
  readOnlyHint?: boolean;
  destructiveHint?: boolean;
  idempotentHint?: boolean;
  openWorldHint?: boolean;
}

export interface Entry {
  name: string;
  description: string;
  field?: { name: string; type: "integer" | "string"; description: string };
  uri?: string;
  inputSchema?: InputSchema;
  annotations?: ToolAnnotations;
}
const searchTasksSchema = {
  type: "object",
  description: "Find tasks in a project and optionally narrow the results by status.",
  properties: {
    project: {
      type: "string",
      description: "Project name. Matching ignores case and surrounding whitespace.",
      examples: ["Conn", "Orbit"],
    },
    statuses: {
      type: "array",
      description: "Match any of these task lanes. Omit to include every lane.",
      items: { type: "string", enum: TASK_LANES },
      examples: [["In progress", "To do"]],
    },
    limit: {
      type: "integer",
      description: "Maximum number of tasks to return.",
      minimum: 1,
      maximum: 25,
      default: 10,
      examples: [3],
    },
    include_pr: {
      type: "boolean",
      description:
        "Include the pull request number and state, or null when the task has no pull request.",
      default: false,
      examples: [true],
    },
  },
  required: ["project"],
  examples: [
    { project: "Conn", statuses: ["In progress", "To do"], limit: 3, include_pr: true },
    { project: "Orbit" },
  ],
} satisfies InputSchema;
const labelPullRequest = { repository: "nckrtl/conn", number: 1931 };
const initialPrLabels = ["needs-review", "desktop"];
const removeLabelTool = "remove_pr_label";
const removePrLabelSchema = {
  type: "object",
  description: "Remove a GitHub pull request label in the local simulation.",
  properties: {
    repository: {
      type: "string",
      description: "GitHub repository in owner/name format.",
      examples: [labelPullRequest.repository],
    },
    number: {
      type: "integer",
      description: "Pull request number.",
      minimum: 1,
      examples: [labelPullRequest.number],
    },
    label: {
      type: "string",
      description: "Label to remove. An absent label is already in the requested state.",
      examples: ["needs-review"],
    },
  },
  required: ["repository", "number", "label"],
  examples: [{ ...labelPullRequest, label: "needs-review" }],
} satisfies InputSchema;
const readOnly = { readOnlyHint: true } as const;
const taskId = {
  name: "id",
  type: "integer",
  description: "Orbit task number, for example 476.",
} as const;
export const catalog: Record<Catalog, Entry[]> = {
  Tools: [
    {
      name: "search_tasks",
      description: "Search tasks by project and status.",
      inputSchema: searchTasksSchema,
      annotations: readOnly,
    },
    { name: "list_tasks", description: "List tasks in the workspace.", annotations: readOnly },
    {
      name: "get_task",
      description: "Look up a task by number.",
      field: taskId,
      annotations: readOnly,
    },
    {
      name: removeLabelTool,
      description: "Remove a label from a GitHub pull request (local simulation).",
      inputSchema: removePrLabelSchema,
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
  ],
  Resources: [
    { name: "Task index", description: "Tasks grouped by project.", uri: "orbit://tasks" },
    {
      name: "Task record",
      description: "Read one task record.",
      uri: "orbit://tasks/{id}",
      field: taskId,
    },
  ],
  Prompts: [
    {
      name: "review_task",
      description: "Prepare a review prompt for an Orbit task.",
      field: { ...taskId, type: "string" },
    },
  ],
};
export const methods = {
  Tools: "tools/call",
  Resources: "resources/read",
  Prompts: "prompts/get",
} as const;
const taskIndex = TASKS.map(({ id, title, project, lane }) => ({
  id,
  title,
  project,
  status: lane,
}));

export interface Exchange {
  durationMs?: number;
  method: string;
  params: object;
  result?: object;
  error?: string;
}
export function listings(): Exchange[] {
  return [
    {
      method: "tools/list",
      params: {},
      result: {
        tools: catalog.Tools.map((item) => ({
          name: item.name,
          description: item.description,
          annotations: item.annotations,
          inputSchema: item.inputSchema ?? {
            type: "object",
            properties: item.field
              ? {
                  [item.field.name]: { type: item.field.type, description: item.field.description },
                }
              : {},
            required: item.field ? [item.field.name] : [],
          },
        })),
      },
    },
    {
      method: "resources/list",
      params: {},
      result: {
        resources: catalog.Resources.filter((item) => !item.field).map(({ uri, name }) => ({
          name,
          uri,
          mimeType: "application/json",
        })),
      },
    },
    {
      method: "resources/templates/list",
      params: {},
      result: {
        resourceTemplates: catalog.Resources.filter((item) => item.field).map(({ uri, name }) => ({
          name,
          uriTemplate: uri,
          mimeType: "application/json",
        })),
      },
    },
    {
      method: "prompts/list",
      params: {},
      result: {
        prompts: catalog.Prompts.map((item) => ({
          name: item.name,
          description: item.description,
          arguments: [{ name: "id", required: true }],
        })),
      },
    },
  ];
}
export function handshake(): Exchange[] {
  return [
    {
      method: "initialize",
      params: {
        protocolVersion: protocol,
        capabilities: {},
        clientInfo: { name: "Conn", version: "lab" },
      },
      result: {
        protocolVersion: protocol,
        serverInfo,
        capabilities: { tools: {}, resources: {}, prompts: {}, logging: {} },
      },
    },
    ...listings(),
  ];
}
export function invoke(kind: Catalog, item: Entry, input: string): Exchange {
  const start = performance.now();
  const response = fixtureResponse(kind, item, input);
  return { ...response, durationMs: performance.now() - start };
}

function fixtureResponse(kind: Catalog, item: Entry, input: string): Exchange {
  if (kind === "Tools" && item.name === "search_tasks") return searchTasks(input);
  if (kind === "Tools" && item.name === removeLabelTool) return removePrLabel(input);
  const value = input.trim();
  const id = Number(value);
  const args = item.field ? { id: item.field.type === "integer" ? id : value } : {};
  const uri = item.uri?.replace("{id}", encodeURIComponent(value));
  const params = kind === "Resources" ? { uri } : { name: item.name, arguments: args };
  const method = methods[kind];
  const task = taskIndex.find((t) => t.id === id);
  if (item.field && !task) return { method, params, error: "Task #" + value + " was not found." };
  const text = JSON.stringify(item.field ? task : taskIndex, null, 2);
  if (kind === "Resources")
    return { method, params, result: { contents: [{ uri, mimeType: "application/json", text }] } };
  if (kind === "Prompts")
    return {
      method,
      params,
      result: {
        messages: [
          {
            role: "user",
            content: {
              type: "text",
              text: `Review task #${value}, “${task?.title}”. Summarize its current status and next action.`,
            },
          },
        ],
      },
    };
  return { method, params, result: { content: [{ type: "text", text }] } };
}

function removePrLabel(input: string): Exchange {
  const method = methods.Tools;
  const request = { name: removeLabelTool };
  let parsed: unknown;
  try {
    parsed = JSON.parse(input);
  } catch {
    return { method, params: request, error: "Enter valid JSON for the label arguments." };
  }
  const params = { ...request, arguments: parsed };
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    return { method, params, error: "Label arguments must be a JSON object." };
  }
  const { repository, number, label } = parsed as Record<string, unknown>;
  if (typeof repository !== "string" || !repository.trim()) {
    return { method, params, error: "repository must be a non-empty string." };
  }
  if (typeof number !== "number" || !Number.isSafeInteger(number) || number < 1) {
    return { method, params, error: "number must be a positive integer." };
  }
  if (typeof label !== "string" || !label.trim()) {
    return { method, params, error: "label must be a non-empty string." };
  }
  if (
    repository.trim().toLowerCase() !== labelPullRequest.repository ||
    number !== labelPullRequest.number
  ) {
    return { method, params, error: "Pull request was not found in the local fixture." };
  }
  const text = JSON.stringify(
    { ...labelPullRequest, label: label.trim(), present: false },
    null,
    2,
  );
  return { method, params, result: { content: [{ type: "text", text }] } };
}

function searchTasks(input: string): Exchange {
  const method = methods.Tools;
  const request = { name: "search_tasks" };
  let parsed: unknown;
  try {
    parsed = JSON.parse(input);
  } catch {
    return { method, params: request, error: "Enter valid JSON for the search arguments." };
  }

  const params = { ...request, arguments: parsed };
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    return { method, params, error: "Search arguments must be a JSON object." };
  }

  const { project, statuses, limit, include_pr } = parsed as Record<string, unknown>;
  const { limit: limitSchema, include_pr: includePrSchema } = searchTasksSchema.properties;
  if (typeof project !== "string" || !project.trim()) {
    return { method, params, error: "project is required and must be a non-empty string." };
  }
  if (
    statuses !== undefined &&
    (!Array.isArray(statuses) ||
      !statuses.every((status) => TASK_LANES.some((lane) => lane === status)))
  ) {
    return {
      method,
      params,
      error: `statuses must be an array of task lanes: ${TASK_LANES.join(", ")}.`,
    };
  }
  if (
    limit !== undefined &&
    (typeof limit !== "number" ||
      !Number.isInteger(limit) ||
      limit < limitSchema.minimum ||
      limit > limitSchema.maximum)
  ) {
    return {
      method,
      params,
      error: `limit must be an integer from ${limitSchema.minimum} to ${limitSchema.maximum}.`,
    };
  }
  if (include_pr !== undefined && typeof include_pr !== "boolean") {
    return { method, params, error: "include_pr must be a boolean." };
  }

  const projectName = project.trim().toLowerCase();
  const matches = TASKS.filter(
    (task) =>
      task.project.toLowerCase() === projectName &&
      (statuses === undefined || statuses.includes(task.lane)),
  )
    .slice(0, limit ?? limitSchema.default)
    .map(({ id, title, project, lane, pr }) => ({
      id,
      title,
      project,
      status: lane,
      ...((include_pr ?? includePrSchema.default) ? { pr } : {}),
    }));
  const text = JSON.stringify(matches, null, 2);
  return { method, params, result: { content: [{ type: "text", text }] } };
}
export interface Pair {
  id: string;
  name: string;
  value: string;
  enabled: boolean;
}
export interface Traffic {
  key: string;
  time: string;
  label: string;
  direction: "Sent" | "Received" | "Closed";
  rpc?: number;
  payload?: object;
}
export interface Draft {
  id: string;
  name: string;
  transport: Transport;
  command: string;
  url: string;
  cwd: string;
  headers: Pair[];
  env: Pair[];
  connected: boolean;
  error: string;
  log: Traffic[];
  seq: number;
  calls: Record<string, Exchange>;
  values: Record<string, Record<string, string>>;
  prLabels: readonly string[];
}
export function draft(name = "", transport: Transport = "HTTP", url = ""): Draft {
  return {
    id: fixtureId(),
    name,
    transport,
    url,
    command: "",
    cwd: "",
    headers: [],
    env: [],
    connected: false,
    error: "",
    log: [],
    seq: 0,
    calls: {},
    values: {},
    prLabels: [...initialPrLabels],
  };
}
export function record(server: Draft, exchanges: Exchange[]): Draft {
  const rows: Traffic[] = [];
  let seq = server.seq;
  let prLabels = server.prLabels ?? initialPrLabels;
  for (const exchange of exchanges) {
    // Apply successful fixture writes to the server that owns the Playground call.
    if (exchange.method === methods.Tools && exchange.result) {
      const params = exchange.params as { name?: string; arguments?: { label?: unknown } };
      const label = params.arguments?.label;
      if (params.name === removeLabelTool && typeof label === "string") {
        const target = label.trim().toLowerCase();
        prLabels = prLabels.filter((current) => current.toLowerCase() !== target);
      }
    }
    const id = ++seq;
    const time = new Date().toISOString().slice(11, 23);
    rows.push(
      {
        key: id + "-out",
        time,
        label: exchange.method,
        direction: "Sent",
        rpc: id,
        payload: { jsonrpc: "2.0", id, method: exchange.method, params: exchange.params },
      },
      {
        key: id + "-in",
        time,
        label: exchange.method + " result",
        direction: "Received",
        rpc: id,
        payload: {
          jsonrpc: "2.0",
          id,
          ...(exchange.error
            ? { error: { code: -32602, message: exchange.error } }
            : { result: exchange.result }),
        },
      },
    );
  }
  return { ...server, log: [...server.log, ...rows].slice(-200), seq, prLabels };
}
export function initialServer() {
  return record({ ...draft("Orbit", "HTTP", demoUrl), connected: true }, handshake());
}
