import { ModelSelection, ProviderInteractionMode, RuntimeMode } from "@t3tools/contracts";
import * as Schema from "effect/Schema";

import type { OrbitGatewayBranchSelection, OrbitGatewayRequest } from "./client.ts";

const Id = Schema.Int.check(Schema.isGreaterThan(0));
const Text = Schema.NullOr(Schema.String);
const Time = Text;
const Source = Schema.Literals(["web", "mobile"]);
const Stage = Schema.Struct({
  status: Schema.Literals(["pending", "running", "succeeded", "failed", "cancelled", "skipped"]),
  started_at: Time,
  finished_at: Time,
  error: Schema.NullOr(Schema.Struct({ code: Schema.String, detail: Text })),
});
const Action = Schema.Struct({ available: Schema.Boolean, reason: Text, requires: Text });

export const OrbitLaunch = Schema.Struct({
  id: Id,
  kind: Schema.Literal("conn.launch"),
  status: Schema.String,
  created_at: Schema.String,
  started_at: Time,
  finished_at: Time,
  cancel_requested: Schema.Boolean,
  poll_after_seconds: Schema.NullOr(Schema.Number),
  error_code: Text,
  launch_id: Schema.String,
  profile_id: Id,
  project_id: Id,
  instance_id: Schema.NullOr(Id),
  workspace_id: Text,
  target_node_id: Id,
  initiator_node_id: Id,
  source: Source,
  phase: Schema.Literals([
    "preparing",
    "dispatching",
    "publishing",
    "ready",
    "needs_retry",
    "cancelling",
    "cancelled",
  ]),
  stages: Schema.Struct({
    workspace_server: Stage,
    first_message: Stage,
    publication: Stage,
    application_preview: Stage,
    cleanup: Stage,
  }),
  readiness: Schema.Struct({
    workspace_server: Schema.NullOr(Schema.Boolean),
    first_message: Schema.NullOr(Schema.Boolean),
    application_preview: Schema.NullOr(Schema.Boolean),
  }),
  actions: Schema.Struct({ cancel: Action, retry_launch: Action, retry_application: Action }),
  children: Schema.Struct({
    create_operation_id: Schema.NullOr(Id),
    wake_operation_id: Schema.NullOr(Id),
    completion_operation_id: Schema.NullOr(Id),
    destroy_operation_id: Schema.NullOr(Id),
  }),
  thread: Schema.NullOr(
    Schema.Struct({
      environment_id: Schema.String,
      project_id: Schema.String,
      thread_id: Schema.String,
      message_id: Schema.String,
      model_selection: ModelSelection,
      accepted_at: Schema.String,
    }),
  ),
});
export type OrbitLaunch = typeof OrbitLaunch.Type;
export type OrbitLaunchStage = typeof Stage.Type;
export type OrbitLaunchAction = keyof OrbitLaunch["actions"];

export interface OrbitLaunchRequest {
  readonly expected_profile_id: number;
  readonly expected_node_id: number;
  readonly project_id: number;
  readonly workspace_id?: string;
  readonly target:
    | { readonly kind: "new"; readonly name: string; readonly branch?: OrbitGatewayBranchSelection }
    | { readonly kind: "existing"; readonly instance_id: number };
  readonly prompt: string;
  readonly model_selection?: ModelSelection;
  readonly runtime_mode?: RuntimeMode;
  readonly interaction_mode?: ProviderInteractionMode;
  readonly source: typeof Source.Type;
  readonly command_id: string;
  readonly thread_id: string;
  readonly message_id: string;
}

export interface OrbitLaunchScope {
  readonly nodeId: number;
  readonly profileId: number;
}

export interface OrbitLaunchAdmission {
  readonly id: string;
  readonly request: OrbitLaunchRequest;
}

export interface OrbitLaunchClient {
  readonly submit: (admission: OrbitLaunchAdmission) => Promise<OrbitLaunch>;
  readonly list: () => Promise<readonly OrbitLaunch[]>;
  readonly read: (id: number) => Promise<OrbitLaunch>;
  readonly cancel: (id: number) => Promise<OrbitLaunch>;
  readonly retry: (id: number, target: "launch" | "application") => Promise<OrbitLaunch>;
}

export function createOrbitLaunchClient(
  call: (request: OrbitGatewayRequest) => Promise<unknown>,
  invalid: (path: string) => Error,
): OrbitLaunchClient {
  const decode = Schema.decodeUnknownOption(OrbitLaunch);
  const read = async (request: OrbitGatewayRequest) => {
    const result = decode(await call(request));
    if (result._tag === "None") throw invalid(request.path);
    return result.value;
  };
  return {
    submit: ({ id, request }) =>
      read({
        method: "POST",
        path: "/launches",
        idempotencyKey: id,
        body: request,
        timeoutMs: 60_000,
      }),
    list: async () => {
      const data = await call({ method: "GET", path: "/launches" });
      if (!Array.isArray(data)) throw invalid("/launches");
      return data.map((row: unknown) => {
        const result = decode(row);
        if (result._tag === "None") throw invalid("/launches");
        return result.value;
      });
    },
    read: (id) => read({ method: "GET", path: `/launches/${id}` }),
    cancel: (id) => read({ method: "POST", path: `/launches/${id}/cancel` }),
    retry: (id, target) =>
      read({ method: "POST", path: `/launches/${id}/retry`, body: { target } }),
  };
}

export function newOrbitLaunchAdmission(
  uuid: () => string,
  scope: OrbitLaunchScope,
  input: Omit<
    OrbitLaunchRequest,
    "expected_profile_id" | "expected_node_id" | "command_id" | "thread_id" | "message_id"
  >,
): OrbitLaunchAdmission {
  return {
    id: uuid(),
    request: {
      ...input,
      expected_profile_id: scope.profileId,
      expected_node_id: scope.nodeId,
      command_id: uuid(),
      thread_id: uuid(),
      message_id: uuid(),
    },
  };
}

export const ORBIT_LAUNCH_STAGES = {
  workspace_server: "Prepare workspace and server",
  first_message: "Send first message",
  publication: "Attach thread to profile",
  application_preview: "Prepare application preview",
  cleanup: "Clean up launch",
} satisfies Record<keyof OrbitLaunch["stages"], string>;

export const ORBIT_LAUNCH_PHASE_LABELS = {
  preparing: "Preparing instance",
  dispatching: "Sending first message",
  publishing: "Attaching thread",
  ready: "Thread ready",
  needs_retry: "Launch needs attention",
  cancelling: "Cancelling",
  cancelled: "Cancelled",
} satisfies Record<OrbitLaunch["phase"], string>;

export const ORBIT_LAUNCH_ACTION_LABELS = {
  cancel: "Cancel launch",
  retry_launch: "Retry launch",
  retry_application: "Retry application",
} satisfies Record<OrbitLaunchAction, string>;

export function orbitLaunchActionLabel(action: OrbitLaunchAction, phase: OrbitLaunch["phase"]) {
  return action === "retry_launch" && phase === "cancelling"
    ? "Retry cleanup"
    : ORBIT_LAUNCH_ACTION_LABELS[action];
}

export function orbitLaunchNeedsAttention(launch: OrbitLaunch): boolean {
  return (
    launch.phase !== "cancelled" &&
    (launch.phase !== "ready" ||
      launch.stages.application_preview.status === "pending" ||
      launch.stages.application_preview.status === "running" ||
      launch.stages.application_preview.status === "failed")
  );
}

export function orbitLaunchShowsInThreadList(launch: OrbitLaunch, threadListed: boolean): boolean {
  return (
    orbitLaunchNeedsAttention(launch) ||
    (launch.phase === "ready" && launch.thread !== null && !threadListed)
  );
}
