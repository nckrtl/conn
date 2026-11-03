import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";

import * as ProcessRunner from "../processRunner.ts";

export const DEFAULT_ORBIT_GATEWAY_URL = "https://gateway.orbit";

export interface OrbitGatewayRequest {
  readonly gatewayUrl: string;
  readonly method: "GET" | "POST";
  readonly path: string;
  readonly query?: Readonly<Record<string, string>>;
  readonly body?: unknown;
  readonly idempotencyKey?: string;
}

export interface OrbitGatewayResponse {
  readonly status: number;
  readonly body: unknown;
}

/** Orbit could not be reached: a transient failure, unlike an answer with an error code. */
export class OrbitGatewayUnreachableError extends Schema.TaggedError<OrbitGatewayUnreachableError>()(
  "OrbitGatewayUnreachableError",
  { reason: Schema.String },
) {
  override get message(): string {
    return this.reason;
  }
}

/**
 * Orbit identifies callers by WireGuard address, so the server calls the Gateway from
 * its own Node. curl, not fetch: the system curl trusts the system CA store, where Orbit
 * installs its root CA, and Node's fetch does not.
 */
export class OrbitGateway extends Context.Service<
  OrbitGateway,
  {
    readonly request: (
      request: OrbitGatewayRequest,
    ) => Effect.Effect<OrbitGatewayResponse, OrbitGatewayUnreachableError>;
  }
>()("t3/orbit/OrbitGateway") {}

const REQUEST_TIMEOUT_SECONDS = 60;

function orbitGatewayUrl(gatewayUrl: string, path: string, query = {}): string {
  const url = new URL(path, `${gatewayUrl.replace(/\/+$/, "")}/`);
  for (const [key, value] of Object.entries<string>(query)) url.searchParams.set(key, value);
  return url.toString();
}

const JsonBody = Schema.fromJsonString(Schema.Unknown);
const decodeJsonBody = Schema.decodeUnknownOption(JsonBody);
const encodeJsonBody = Schema.encodeSync(JsonBody);

/** curl's `-w '\n%{http_code}'` output: the body, then the status on the last line. */
function parseCurlResponse(stdout: string): OrbitGatewayResponse | null {
  const lastNewline = stdout.lastIndexOf("\n");
  const status = Number(stdout.slice(lastNewline + 1).trim());
  if (!Number.isInteger(status) || status <= 0) return null;
  const bodyText = lastNewline === -1 ? "" : stdout.slice(0, lastNewline);
  if (bodyText.trim() === "") return { status, body: null };
  const body = decodeJsonBody(bodyText);
  return { status, body: body._tag === "Some" ? body.value : bodyText };
}

const make = Effect.gen(function* () {
  const runner = yield* ProcessRunner.ProcessRunner;
  const fs = yield* FileSystem.FileSystem;
  // A shell PATH can put another curl (e.g. Homebrew's) first.
  const curl = (yield* fs.exists("/usr/bin/curl").pipe(Effect.orElseSucceed(() => false)))
    ? "/usr/bin/curl"
    : "curl";

  const request: OrbitGateway["Service"]["request"] = Effect.fn("OrbitGateway.request")(
    function* (input) {
      const url = orbitGatewayUrl(input.gatewayUrl, input.path, input.query);
      const hasBody = input.body !== undefined;
      const args = [
        "-sS",
        "--max-time",
        String(REQUEST_TIMEOUT_SECONDS),
        "-X",
        input.method,
        "-H",
        "accept: application/json",
        ...(hasBody ? ["-H", "content-type: application/json", "--data-binary", "@-"] : []),
        ...(input.idempotencyKey ? ["-H", `idempotency-key: ${input.idempotencyKey}`] : []),
        "-w",
        "\n%{http_code}",
        url,
      ];
      const output = yield* runner
        .run({
          command: curl,
          args,
          timeout: `${REQUEST_TIMEOUT_SECONDS + 10} seconds`,
          ...(hasBody ? { stdin: encodeJsonBody(input.body) } : {}),
        })
        .pipe(
          Effect.mapError(
            (cause) =>
              new OrbitGatewayUnreachableError({ reason: `Could not run curl: ${cause.message}` }),
          ),
        );
      if (output.code !== 0) {
        const detail = output.stderr.trim().split("\n").at(-1) ?? "";
        return yield* new OrbitGatewayUnreachableError({
          reason: `Orbit is not reachable from this machine${detail ? `: ${detail}` : "."}`,
        });
      }
      const response = parseCurlResponse(output.stdout);
      if (response === null) {
        return yield* new OrbitGatewayUnreachableError({
          reason: "Orbit returned no HTTP status.",
        });
      }
      return response;
    },
  );

  return OrbitGateway.of({ request });
});

export const layer = Layer.effect(OrbitGateway, make).pipe(Layer.provide(ProcessRunner.layer));
