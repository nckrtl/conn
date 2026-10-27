import * as Schema from "effect/Schema";

import { ProjectId } from "./baseSchemas.ts";

// Fork patch: Conn-native browser and device annotations. The Conn server stores them per
// project; the browser overlay, the Device panel and agents (through MCP tools) share one
// queue. No @nckrtl/annotator server is involved.

export const AnnotationStatus = Schema.Literals(["todo", "in_progress", "done"]);
export type AnnotationStatus = typeof AnnotationStatus.Type;

export const AnnotationId = Schema.String.check(
  Schema.isPattern(/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,199}$/),
);
export type AnnotationId = typeof AnnotationId.Type;

export const AnnotationRect = Schema.Struct({
  x: Schema.Number,
  y: Schema.Number,
  width: Schema.Number,
  height: Schema.Number,
});
export type AnnotationRect = typeof AnnotationRect.Type;

export const AnnotationComponentFrame = Schema.Struct({
  name: Schema.String,
  file: Schema.optional(Schema.String),
  line: Schema.optional(Schema.Number),
});
export type AnnotationComponentFrame = typeof AnnotationComponentFrame.Type;

/**
 * What the overlay or the Device panel captures. Browser annotations carry the page and
 * element context; device annotations carry a normalized rect (`x`, `y`, `width`, `height`
 * from 0 to 1) and a `device/<host>/<device>` pathname.
 */
export const AnnotationCapture = Schema.Struct({
  id: AnnotationId,
  comment: Schema.String,
  /** `browser` or `device`. */
  source: Schema.optional(Schema.Literals(["browser", "device"])),
  /** The page URL, for browser annotations. */
  url: Schema.optional(Schema.String),
  pathname: Schema.optional(Schema.String),
  element: Schema.optional(Schema.String),
  elementPath: Schema.optional(Schema.String),
  x: Schema.optional(Schema.Number),
  y: Schema.optional(Schema.Number),
  width: Schema.optional(Schema.Number),
  height: Schema.optional(Schema.Number),
  boundingBox: Schema.optional(AnnotationRect),
  isFixed: Schema.optional(Schema.Boolean),
  timestamp: Schema.optional(Schema.Number),
  component: Schema.optional(Schema.String),
  components: Schema.optional(Schema.Array(AnnotationComponentFrame)),
  controller: Schema.optional(Schema.String),
  route: Schema.optional(Schema.String),
  react: Schema.optional(Schema.String),
  screenSize: Schema.optional(Schema.String),
  scrollPosition: Schema.optional(Schema.String),
  breakpoint: Schema.optional(Schema.String),
  appearance: Schema.optional(Schema.Unknown),
  change: Schema.optional(Schema.Unknown),
  metadata: Schema.optional(Schema.Record(Schema.String, Schema.Unknown)),
  /** A `data:image/...;base64,` screenshot. Stored as a file; records only say it exists. */
  screenshot: Schema.optional(Schema.String),
});
export type AnnotationCapture = typeof AnnotationCapture.Type;

export const AnnotationRecord = Schema.Struct({
  ...AnnotationCapture.fields,
  screenshot: Schema.optional(Schema.Never),
  projectId: ProjectId,
  /** Stable per-project number, shown to people as `#3`. */
  number: Schema.Number,
  /** Increases on every change in the project, so a client can drop stale copies. */
  revision: Schema.Number,
  status: AnnotationStatus,
  summary: Schema.optional(Schema.String),
  /** The agent released it with a question; the answer comes in the thread. */
  question: Schema.optional(Schema.Boolean),
  hasScreenshot: Schema.Boolean,
  createdAt: Schema.String,
  claimedAt: Schema.optional(Schema.String),
  completedAt: Schema.optional(Schema.String),
});
export type AnnotationRecord = typeof AnnotationRecord.Type;

export const AnnotationProjectInput = Schema.Struct({ projectId: ProjectId });
export type AnnotationProjectInput = typeof AnnotationProjectInput.Type;

export const AnnotationList = Schema.Struct({
  annotations: Schema.Array(AnnotationRecord),
});
export type AnnotationList = typeof AnnotationList.Type;

export const AnnotationCreateInput = Schema.Struct({
  projectId: ProjectId,
  annotation: AnnotationCapture,
});
export type AnnotationCreateInput = typeof AnnotationCreateInput.Type;

export const AnnotationCreateResult = Schema.Struct({ annotation: AnnotationRecord });
export type AnnotationCreateResult = typeof AnnotationCreateResult.Type;

/** `ids` removes those; `done` removes every done one; `idle` everything not in progress. */
export const AnnotationRemoveInput = Schema.Struct({
  projectId: ProjectId,
  ids: Schema.optional(Schema.Array(AnnotationId)),
  scope: Schema.optional(Schema.Literals(["done", "idle"])),
});
export type AnnotationRemoveInput = typeof AnnotationRemoveInput.Type;

export const AnnotationRemoveResult = Schema.Struct({
  removedIds: Schema.Array(AnnotationId),
});
export type AnnotationRemoveResult = typeof AnnotationRemoveResult.Type;

export class AnnotationProjectNotFoundError extends Schema.TaggedError<AnnotationProjectNotFoundError>()(
  "AnnotationProjectNotFoundError",
  { projectId: ProjectId },
) {
  override get message(): string {
    return "This project is not on this server.";
  }
}

export class AnnotationStoreError extends Schema.TaggedError<AnnotationStoreError>()(
  "AnnotationStoreError",
  {
    reason: Schema.String,
    cause: Schema.optional(Schema.Defect()),
  },
) {
  override get message(): string {
    return this.reason;
  }
}

export class AnnotationNotFoundError extends Schema.TaggedError<AnnotationNotFoundError>()(
  "AnnotationNotFoundError",
  { projectId: ProjectId, id: AnnotationId },
) {
  override get message(): string {
    return `Annotation ${this.id} is gone. The user may have removed it; do not recreate it.`;
  }
}

/** The status change is not allowed from the annotation's current status. */
export class AnnotationConflictError extends Schema.TaggedError<AnnotationConflictError>()(
  "AnnotationConflictError",
  { id: AnnotationId, status: AnnotationStatus, expected: AnnotationStatus },
) {
  override get message(): string {
    return `Annotation ${this.id} is ${this.status}; it must be ${this.expected}. Read the list again.`;
  }
}

/** The id was removed, so a stale overlay cannot bring it back. */
export class AnnotationRemovedError extends Schema.TaggedError<AnnotationRemovedError>()(
  "AnnotationRemovedError",
  { id: AnnotationId },
) {
  override get message(): string {
    return `Annotation ${this.id} was removed.`;
  }
}

export class AnnotationInvalidError extends Schema.TaggedError<AnnotationInvalidError>()(
  "AnnotationInvalidError",
  { reason: Schema.String },
) {
  override get message(): string {
    return this.reason;
  }
}

export const AnnotationListToolInput = Schema.Struct({
  all: Schema.optional(
    Schema.Boolean.annotate({
      description: "Also list done annotations. By default only todo and in-progress ones.",
    }),
  ),
});
export type AnnotationListToolInput = typeof AnnotationListToolInput.Type;

export const AnnotationClaimToolInput = Schema.Struct({
  id: Schema.optional(
    AnnotationId.annotate({
      description:
        "Claim this annotation, such as one you asked a question about. Omit to claim the oldest waiting one.",
    }),
  ),
});
export type AnnotationClaimToolInput = typeof AnnotationClaimToolInput.Type;

export const AnnotationClaimed = Schema.Struct({
  ...AnnotationRecord.fields,
  /** Local path of the screenshot, when the annotation has one. */
  screenshotPath: Schema.optional(Schema.String),
});
export type AnnotationClaimed = typeof AnnotationClaimed.Type;

export const AnnotationClaimToolResult = Schema.Struct({
  /** Null when no annotation waits. */
  annotation: Schema.NullOr(AnnotationClaimed),
});
export type AnnotationClaimToolResult = typeof AnnotationClaimToolResult.Type;

export const AnnotationCompleteToolInput = Schema.Struct({
  id: AnnotationId,
  summary: Schema.String.annotate({ description: "One line: the change and the checks you ran." }),
});
export type AnnotationCompleteToolInput = typeof AnnotationCompleteToolInput.Type;

export const AnnotationReleaseToolInput = Schema.Struct({
  id: AnnotationId,
  summary: Schema.optional(
    Schema.String.annotate({
      description: "Why you stopped, or with question: true, the question for the user.",
    }),
  ),
  question: Schema.optional(
    Schema.Boolean.annotate({
      description: "Release it as a question for the user. Needs the question as summary.",
    }),
  ),
});
export type AnnotationReleaseToolInput = typeof AnnotationReleaseToolInput.Type;

export const AnnotationToolResult = Schema.Struct({ annotation: AnnotationRecord });
export type AnnotationToolResult = typeof AnnotationToolResult.Type;
