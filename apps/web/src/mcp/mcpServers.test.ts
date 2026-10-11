import { describe, expect, it } from "vite-plus/test";

import {
  argumentsFromFields,
  expandTemplate,
  fieldsFromSchema,
  quoteWord,
  serversFromMcpJson,
  splitCommandLine,
  templateVariables,
  toDesktopMcpServer,
} from "./mcpServers";

describe("splitCommandLine", () => {
  it("splits words and keeps quoted spaces", () => {
    expect(splitCommandLine(`php artisan mcp:start "my server" 'a b' c\\ d ""`)).toEqual([
      "php",
      "artisan",
      "mcp:start",
      "my server",
      "a b",
      "c d",
      "",
    ]);
  });

  it("round-trips quoted words", () => {
    const words = ["npx", "-y", "it's here", "--flag=a b", ""];
    expect(splitCommandLine(words.map(quoteWord).join(" "))).toEqual(words);
  });
});

describe("serversFromMcpJson", () => {
  it("reads stdio and HTTP servers from mcpServers or servers", () => {
    const servers = serversFromMcpJson(
      JSON.stringify({
        mcpServers: {
          laravel: { command: "php", args: ["artisan", "boost:mcp"], env: { APP_ENV: "local" } },
          remote: { type: "sse", url: "https://app.test/sse", headers: { Authorization: "x" } },
          broken: { args: [] },
        },
      }),
    );
    expect(servers.map((server) => [server.id, server.transport])).toEqual([
      ["mcp.json:laravel", "stdio"],
      ["mcp.json:remote", "sse"],
    ]);
    expect(servers[0]?.commandLine).toBe("php artisan boost:mcp");
    expect(servers[0]?.env.map((row) => [row.name, row.value])).toEqual([["APP_ENV", "local"]]);
    expect(
      serversFromMcpJson(JSON.stringify({ servers: { a: { url: "http://x" } } }))[0]?.transport,
    ).toBe("http");
    expect(serversFromMcpJson("not json")).toEqual([]);
  });
});

describe("toDesktopMcpServer", () => {
  it("runs a stdio server in the project folder unless the server sets one", () => {
    const [server] = serversFromMcpJson(
      JSON.stringify({ mcpServers: { a: { command: "node", args: ["server.js"] } } }),
    );
    expect(toDesktopMcpServer(server!, "/repo")).toEqual({
      transport: "stdio",
      command: "node",
      args: ["server.js"],
      env: {},
      cwd: "/repo",
    });
    expect(toDesktopMcpServer({ ...server!, commandLine: " " }, "/repo")).toEqual({
      error: "Enter the command that starts the server.",
    });
  });
});

describe("tool arguments", () => {
  const fields = fieldsFromSchema({
    type: "object",
    properties: {
      query: { type: "string" },
      limit: { type: "integer", default: 10 },
      exact: { type: "boolean" },
      mode: { enum: ["fast", "full"] },
      filters: { type: "object" },
      note: { type: ["string", "null"] },
    },
    required: ["query"],
  });

  it("maps schema properties to field types", () => {
    expect(fields.map((field) => [field.name, field.type, field.required])).toEqual([
      ["query", "string", true],
      ["limit", "integer", false],
      ["exact", "boolean", false],
      ["mode", "enum", false],
      ["filters", "json", false],
      ["note", "string", false],
    ]);
  });

  it("converts form text and leaves out empty optional fields", () => {
    expect(
      argumentsFromFields(fields, { query: "", exact: "true", filters: '{"a":1}', mode: "" }),
    ).toEqual({ arguments: { query: "", limit: 10, exact: true, filters: { a: 1 } } });
    expect(argumentsFromFields(fields, { limit: "2.5" })).toEqual({
      error: "limit must be a whole number.",
    });
    expect(argumentsFromFields(fields, { filters: "{" })).toEqual({
      error: "filters must be valid JSON.",
    });
  });
});

describe("resource templates", () => {
  it("finds and fills placeholders", () => {
    const template = "file:///{+path}{?rev,raw}";
    expect(templateVariables(template)).toEqual(["path", "rev", "raw"]);
    expect(expandTemplate(template, { path: "a b/c.txt", rev: "1&2", raw: "" })).toBe(
      "file:///a%20b/c.txt?rev=1%262&raw=",
    );
    expect(expandTemplate("users://{id}/posts", { id: "a/b" })).toBe("users://a%2Fb/posts");
  });
});
