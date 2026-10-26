import * as Schema from "effect/Schema";

import { ProjectId } from "./baseSchemas.ts";

// rooms-patches: the @nckrtl/annotator server a project runs for browser annotations.

export const AnnotatorServerAction = Schema.Literals(["start", "stop", "status"]);
export type AnnotatorServerAction = typeof AnnotatorServerAction.Type;

export const AnnotatorServerInput = Schema.Struct({
  projectId: ProjectId,
  action: AnnotatorServerAction,
});
export type AnnotatorServerInput = typeof AnnotatorServerInput.Type;

export const AnnotatorServerStatus = Schema.Struct({
  running: Schema.Boolean,
  /** The annotations URL, such as `http://10.44.0.7:47821/annotations`, while it runs. */
  url: Schema.NullOr(Schema.String),
});
export type AnnotatorServerStatus = typeof AnnotatorServerStatus.Type;

export class AnnotatorProjectNotFoundError extends Schema.TaggedError<AnnotatorProjectNotFoundError>()(
  "AnnotatorProjectNotFoundError",
  { projectId: ProjectId },
) {
  override get message(): string {
    return "This project is not on this server.";
  }
}

export class AnnotatorServerError extends Schema.TaggedError<AnnotatorServerError>()(
  "AnnotatorServerError",
  {
    action: AnnotatorServerAction,
    projectId: ProjectId,
    /** The server's log, which says why it did not start. */
    logPath: Schema.String,
    cause: Schema.optional(Schema.Defect()),
  },
) {
  override get message(): string {
    return `Could not ${this.action === "status" ? "read" : this.action} the annotation server. See ${this.logPath}.`;
  }
}
