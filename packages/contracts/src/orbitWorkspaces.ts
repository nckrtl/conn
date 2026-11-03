import * as Schema from "effect/Schema";

import { ThreadId } from "./baseSchemas.ts";

// Fork patch: a thread's Orbit workspace. The client creates the worktree in Orbit's apps
// path; the server registers it as an Orbit Instance once the branch has its name, so no
// client has to stay open. Records persist per thread and survive a server restart.

/** `waiting` for the branch name, `registering` with Orbit, then `registered` or `failed`. */
export const OrbitWorkspacePhase = Schema.Literals([
  "waiting",
  "registering",
  "registered",
  "failed",
]);
export type OrbitWorkspacePhase = typeof OrbitWorkspacePhase.Type;

export const OrbitWorkspaceFailure = Schema.Struct({
  /** Orbit's error code, such as `operation.kind_unavailable`. */
  code: Schema.String,
  message: Schema.String,
  /** The Operation step that failed, when Orbit names one. */
  step: Schema.optional(Schema.String),
});
export type OrbitWorkspaceFailure = typeof OrbitWorkspaceFailure.Type;

export const OrbitWorkspaceRegisterInput = Schema.Struct({
  threadId: ThreadId,
  /** The Orbit Instance name, also the checkout's folder name, e.g. `t3-1a2b3c4d`. */
  instanceName: Schema.String,
  orbitProjectId: Schema.Number,
  projectSlug: Schema.String,
  tld: Schema.String,
  checkoutPath: Schema.String,
  temporaryBranch: Schema.String,
  /** Defaults to `https://gateway.orbit`. */
  gatewayUrl: Schema.optional(Schema.String),
});
export type OrbitWorkspaceRegisterInput = typeof OrbitWorkspaceRegisterInput.Type;

export const OrbitWorkspaceRegistration = Schema.Struct({
  ...OrbitWorkspaceRegisterInput.fields,
  gatewayUrl: Schema.String,
  phase: OrbitWorkspacePhase,
  createdAt: Schema.String,
  updatedAt: Schema.String,
  /** The route domain last sent to Orbit. */
  domain: Schema.NullOr(Schema.String),
  /** An admitted registration Operation; a restart follows it instead of registering again. */
  operationId: Schema.NullOr(Schema.Number),
  /** Idempotency key of this attempt, so a request repeated after a restart is not doubled. */
  requestKey: Schema.NullOr(Schema.String),
  instanceId: Schema.NullOr(Schema.Number),
  url: Schema.NullOr(Schema.String),
  failure: Schema.NullOr(OrbitWorkspaceFailure),
});
export type OrbitWorkspaceRegistration = typeof OrbitWorkspaceRegistration.Type;

export const OrbitWorkspaceList = Schema.Struct({
  registrations: Schema.Array(OrbitWorkspaceRegistration),
});
export type OrbitWorkspaceList = typeof OrbitWorkspaceList.Type;

export const OrbitWorkspaceThreadInput = Schema.Struct({ threadId: ThreadId });
export type OrbitWorkspaceThreadInput = typeof OrbitWorkspaceThreadInput.Type;

export class OrbitWorkspaceStoreError extends Schema.TaggedError<OrbitWorkspaceStoreError>()(
  "OrbitWorkspaceStoreError",
  {
    reason: Schema.String,
    cause: Schema.optional(Schema.Defect()),
  },
) {
  override get message(): string {
    return this.reason;
  }
}
