import type { DesktopMcpServer } from "@t3tools/contracts";

import { type ApiHeaderRow, newRowId } from "../api/apiRequestStore";

// The MCP panel's server drafts and the pure helpers around them: command lines, `.mcp.json`,
// and tool input schemas turned into form fields.

export const MCP_TRANSPORTS = ["stdio", "http", "sse"] as const;
export type McpTransport = (typeof MCP_TRANSPORTS)[number];

export const MCP_TRANSPORT_LABELS: Record<McpTransport, string> = {
  stdio: "STDIO",
  http: "HTTP",
  sse: "SSE",
};

export interface McpServerDraft {
  readonly id: string;
  readonly name: string;
  readonly transport: McpTransport;
  /** stdio: the command and its arguments, as typed in a shell. */
  readonly commandLine: string;
  /** http and sse: the server URL. */
  readonly url: string;
  readonly headers: readonly ApiHeaderRow[];
  readonly env: readonly ApiHeaderRow[];
  /** stdio: the folder the command runs in; empty for the project folder. */
  readonly cwd: string;
}

/** A new HTTP server at the project's app URL (Laravel MCP serves `/mcp`), or a blank one. */
export function newMcpServer(baseUrl: string | null): McpServerDraft {
  return {
    id: newRowId(),
    name: "",
    transport: baseUrl ? "http" : "stdio",
    commandLine: "",
    url: baseUrl ? `${baseUrl.replace(/\/+$/, "")}/mcp` : "",
    headers: [],
    env: [],
    cwd: "",
  };
}

/** The server's name, or what it runs or reaches. */
export function mcpServerLabel(server: McpServerDraft): string {
  if (server.name.trim()) return server.name.trim();
  const target = server.transport === "stdio" ? server.commandLine.trim() : server.url.trim();
  return target || "New server";
}

/** Splits a command line like a POSIX shell does for words and quotes (no expansion). */
export function splitCommandLine(line: string): string[] {
  const words: string[] = [];
  let word = "";
  let started = false;
  let quote: '"' | "'" | null = null;
  for (let index = 0; index < line.length; index += 1) {
    const char = line[index]!;
    if (quote) {
      if (char === quote) quote = null;
      else if (char === "\\" && quote === '"' && /["\\$`]/.test(line[index + 1] ?? "")) {
        word += line[(index += 1)];
      } else word += char;
    } else if (char === '"' || char === "'") {
      quote = char;
      started = true;
    } else if (char === "\\" && index + 1 < line.length) {
      word += line[(index += 1)];
      started = true;
    } else if (/\s/.test(char)) {
      if (started) words.push(word);
      word = "";
      started = false;
    } else {
      word += char;
      started = true;
    }
  }
  if (started) words.push(word);
  return words;
}

/** Quotes a word only when a shell would split or expand it. */
export function quoteWord(word: string): string {
  if (word !== "" && /^[\w@%+=:,./~-]+$/.test(word)) return word;
  return `'${word.replaceAll("'", `'\\''`)}'`;
}

function enabledRows(rows: readonly ApiHeaderRow[]) {
  return rows.filter((row) => row.enabled && row.name.trim());
}

/** The draft as the desktop shell connects to it; `projectCwd` stands in for an empty folder. */
export function toDesktopMcpServer(
  server: McpServerDraft,
  projectCwd: string | null,
): DesktopMcpServer | { error: string } {
  if (server.transport === "stdio") {
    const [command, ...args] = splitCommandLine(server.commandLine);
    if (!command) return { error: "Enter the command that starts the server." };
    return {
      transport: "stdio",
      command,
      args,
      env: Object.fromEntries(enabledRows(server.env).map((row) => [row.name.trim(), row.value])),
      cwd: server.cwd.trim() || projectCwd,
    };
  }
  if (!server.url.trim()) return { error: "Enter the server URL." };
  return {
    transport: server.transport,
    url: server.url.trim(),
    headers: enabledRows(server.headers).map((row) => ({
      name: row.name.trim(),
      value: row.value,
    })),
  };
}

function rowsFrom(record: unknown): ApiHeaderRow[] {
  if (typeof record !== "object" || record === null) return [];
  return Object.entries(record).flatMap(([name, value]) =>
    typeof value === "string" ? [{ id: newRowId(), name, value, enabled: true }] : [],
  );
}

/**
 * The servers in a project's `.mcp.json` (Claude Code's `mcpServers` or VS Code's `servers`).
 * Ids are stable per name, so the panel can tell an imported server from a new one.
 */
export function serversFromMcpJson(contents: string): McpServerDraft[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(contents);
  } catch {
    return [];
  }
  if (typeof parsed !== "object" || parsed === null) return [];
  const root = parsed as Record<string, unknown>;
  const servers = root.mcpServers ?? root.servers;
  if (typeof servers !== "object" || servers === null) return [];
  return Object.entries(servers).flatMap(([name, value]): McpServerDraft[] => {
    if (typeof value !== "object" || value === null) return [];
    const entry = value as Record<string, unknown>;
    const base = { id: `mcp.json:${name}`, name, headers: [], env: [], cwd: "", commandLine: "" };
    if (typeof entry.url === "string") {
      return [
        {
          ...base,
          transport: entry.type === "sse" ? "sse" : "http",
          url: entry.url,
          headers: rowsFrom(entry.headers),
        },
      ];
    }
    if (typeof entry.command !== "string") return [];
    const args = Array.isArray(entry.args)
      ? entry.args.filter((arg) => typeof arg === "string")
      : [];
    return [
      {
        ...base,
        transport: "stdio",
        url: "",
        commandLine: [entry.command, ...args].map(quoteWord).join(" "),
        env: rowsFrom(entry.env),
        cwd: typeof entry.cwd === "string" ? entry.cwd : "",
      },
    ];
  });
}

// ─── Tool input schemas ─────────────────────────────────────────────────────

export type McpFieldType = "string" | "number" | "integer" | "boolean" | "enum" | "json";

export interface McpField {
  readonly name: string;
  readonly type: McpFieldType;
  readonly required: boolean;
  readonly description: string | null;
  readonly options: readonly string[];
  /** The schema's default, as the form's text. */
  readonly defaultText: string;
}

function fieldType(schema: Record<string, unknown>): McpFieldType {
  if (Array.isArray(schema.enum) && schema.enum.every((value) => typeof value === "string")) {
    return "enum";
  }
  const type = Array.isArray(schema.type)
    ? schema.type.find((candidate) => candidate !== "null")
    : schema.type;
  return type === "string" || type === "number" || type === "integer" || type === "boolean"
    ? type
    : "json";
}

/** One form field per top-level property; objects and arrays are edited as JSON. */
export function fieldsFromSchema(schema: unknown): McpField[] {
  if (typeof schema !== "object" || schema === null) return [];
  const { properties, required } = schema as Record<string, unknown>;
  if (typeof properties !== "object" || properties === null) return [];
  const requiredNames = new Set(Array.isArray(required) ? required : []);
  return Object.entries(properties).map(([name, value]) => {
    const property = typeof value === "object" && value !== null ? value : {};
    const spec = property as Record<string, unknown>;
    const type = fieldType(spec);
    const fallback = spec.default;
    return {
      name,
      type,
      required: requiredNames.has(name),
      description: typeof spec.description === "string" ? spec.description : null,
      options: type === "enum" ? (spec.enum as string[]) : [],
      defaultText:
        fallback === undefined
          ? ""
          : type === "json"
            ? JSON.stringify(fallback, null, 2)
            : String(fallback),
    };
  });
}

/** The call's arguments from the form's text values; empty optional fields are left out. */
export function argumentsFromFields(
  fields: readonly McpField[],
  values: Readonly<Record<string, string>>,
): { arguments: Record<string, unknown> } | { error: string } {
  const args: Record<string, unknown> = {};
  for (const field of fields) {
    const text = values[field.name] ?? field.defaultText;
    if (text.trim() === "" && field.type !== "string") {
      if (field.required) return { error: `${field.name} is required.` };
      continue;
    }
    if (text === "" && !field.required) continue;
    switch (field.type) {
      case "string":
      case "enum":
        args[field.name] = text;
        break;
      case "boolean":
        args[field.name] = text === "true";
        break;
      case "number":
      case "integer": {
        const number = Number(text);
        if (!Number.isFinite(number) || (field.type === "integer" && !Number.isInteger(number))) {
          return {
            error: `${field.name} must be ${field.type === "integer" ? "a whole" : "a"} number.`,
          };
        }
        args[field.name] = number;
        break;
      }
      case "json":
        try {
          args[field.name] = JSON.parse(text);
        } catch {
          return { error: `${field.name} must be valid JSON.` };
        }
    }
  }
  return { arguments: args };
}

/** `{name}` placeholders of an RFC 6570 URI template (operators like `{+path}` keep the name). */
export function templateVariables(template: string): string[] {
  const names = new Set<string>();
  for (const match of template.matchAll(/\{[+#./;?&]?([^}]+)\}/g)) {
    for (const part of match[1]!.split(",")) names.add(part.replace(/[*:].*$/, "").trim());
  }
  return [...names].filter(Boolean);
}

/** Fills a URI template's placeholders (RFC 6570 level 3, without explode or prefix modifiers). */
export function expandTemplate(template: string, values: Readonly<Record<string, string>>): string {
  return template.replace(/\{([+#./;?&]?)([^}]+)\}/g, (_, operator: string, list: string) => {
    const names = list.split(",").map((name) => name.replace(/[*:].*$/, "").trim());
    const encode = operator === "+" || operator === "#" ? encodeURI : encodeURIComponent;
    const value = (name: string) => encode(values[name] ?? "");
    switch (operator) {
      case "?":
      case "&":
        return operator + names.map((name) => `${name}=${value(name)}`).join("&");
      case ";":
        return names.map((name) => `;${name}=${value(name)}`).join("");
      case "/":
      case ".":
        return names.map((name) => operator + value(name)).join("");
      case "#":
        return `#${names.map(value).join(",")}`;
      default:
        return names.map(value).join(",");
    }
  });
}
