// Tool input schemas as form fields, from apps/web/src/mcp/mcpServers.ts.

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
