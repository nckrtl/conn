import type {
  OrbitExistingInstance,
  OrbitGatewayProject,
  OrbitInstanceKind,
} from "@t3tools/client-runtime/orbit-gateway";
import {
  EnvironmentId,
  ProjectId,
  type ModelSelection,
  type OrbitInstanceDescriptor,
  type ProviderInteractionMode,
  type RuntimeMode,
} from "@t3tools/contracts";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

/**
 * Conn: where an Orbit draft starts (FORK.md, "Orbit"). An Orbit Project is no T3 project, so the
 * draft is anchored on a real environment for its model list. Not the worktree env mode "orbit".
 */
export const OrbitDraftExistingInstance = Schema.Struct({
  instanceId: Schema.Number,
  environmentId: Schema.String,
});
export type OrbitDraftExistingInstance = typeof OrbitDraftExistingInstance.Type;

export const OrbitDraftTarget = Schema.Struct({
  projectId: Schema.Number,
  projectSlug: Schema.String,
  projectName: Schema.String,
  nodeName: Schema.String,
  instanceKind: Schema.Literals(["new", "existing"]),
  /** The name the user typed for a new Instance, or the existing Instance's name. */
  instanceName: Schema.String,
  /** Set for an existing Instance this device has not paired yet. */
  existing: Schema.NullOr(OrbitDraftExistingInstance),
  /** Such as `.nckrtl.test`, when Orbit or a seen clone gave it. */
  domainSuffix: Schema.NullOr(Schema.String),
});
export type OrbitDraftTarget = typeof OrbitDraftTarget.Type;

const decodeOrbitDraftTarget = Schema.decodeUnknownOption(OrbitDraftTarget);

/** A saved target, or null when the row is missing, old or broken. */
export function readOrbitDraftTarget(value: unknown): OrbitDraftTarget | null {
  if (value === undefined || value === null) return null;
  const decoded = Option.getOrNull(decodeOrbitDraftTarget(value));
  if (decoded === null) return null;
  if (decoded.instanceKind === "existing" && decoded.existing === null) return null;
  if (decoded.instanceName.trim() === "") return null;
  return decoded;
}

export function orbitDraftTargetsEqual(
  left: OrbitDraftTarget | null | undefined,
  right: OrbitDraftTarget | null | undefined,
): boolean {
  if (!left || !right) return (left ?? null) === (right ?? null);
  return JSON.stringify(left) === JSON.stringify(right);
}

/**
 * The draft's project id. It names no T3 project, so the composer finds no `activeProject` and
 * no project tools (git, scripts, worktrees) act on the anchor environment.
 */
export function orbitDraftProjectId(orbitProjectId: number): ProjectId {
  return ProjectId.make(`orbit-project:${orbitProjectId}`);
}

/** One Orbit draft per Orbit Project, like one draft per T3 project. */
export function orbitDraftLogicalProjectKey(orbitProjectId: number): string {
  return `orbit-project:${orbitProjectId}`;
}

/**
 * The environment the draft is anchored on before the Instance exists: a paired clone of the same
 * Orbit Project if this device has one (its providers match best), else the primary environment.
 * The start carries the chosen model; if the new clone lacks that provider, PR 4 falls back.
 */
export function chooseOrbitDraftAnchor(input: {
  readonly orbitProjectId: number;
  readonly orbitInstances: Readonly<Record<string, OrbitInstanceDescriptor>>;
  readonly savedEnvironmentIds: ReadonlySet<string>;
  readonly primaryEnvironmentId: string | null;
}): EnvironmentId | null {
  const clone = Object.entries(input.orbitInstances)
    .filter(
      ([environmentId, instance]) =>
        instance.projectId === input.orbitProjectId && input.savedEnvironmentIds.has(environmentId),
    )
    .map(([environmentId]) => environmentId)
    .toSorted()[0];
  const anchor = clone ?? input.primaryEnvironmentId;
  return anchor ? EnvironmentId.make(anchor) : null;
}

export interface OrbitDraftContextRow {
  /** Plain text: the Node menu waits for Orbit. */
  readonly nodeLabel: string;
  /** `<instance slug> · <project slug>`. */
  readonly instanceLabel: string;
  readonly instanceTitle: string;
}

export function orbitDraftContextRow(target: OrbitDraftTarget): OrbitDraftContextRow {
  const instanceLabel = `${target.instanceName} · ${target.projectSlug}`;
  return {
    nodeLabel: target.nodeName,
    instanceLabel,
    instanceTitle:
      target.instanceKind === "new"
        ? `New instance ${target.instanceName}${target.domainSuffix ?? ""} in ${target.projectName}. Click to change.`
        : `Instance ${target.instanceName} of ${target.projectName}. Click to change.`,
  };
}

export const ORBIT_NEW_INSTANCE_ATTACHMENTS_NOTICE =
  "Attachments are not available for a new Instance yet.";
export const ORBIT_UNPAIRED_INSTANCE_ATTACHMENTS_NOTICE =
  "Attachments are not available until this Instance is connected.";

/**
 * Why the composer takes no attachments, or null. The start machine sends the first message as
 * text only (v1, decided), so the attach control says so instead of looking broken.
 */
export function orbitDraftAttachmentsBlockedReason(
  target: OrbitDraftTarget | null | undefined,
): string | null {
  if (!target) return null;
  return target.instanceKind === "new"
    ? ORBIT_NEW_INSTANCE_ATTACHMENTS_NOTICE
    : ORBIT_UNPAIRED_INSTANCE_ATTACHMENTS_NOTICE;
}

/** The Gateway project the start record needs, from the target alone. */
export function orbitDraftGatewayProject(
  target: OrbitDraftTarget,
): Pick<OrbitGatewayProject, "id" | "slug" | "nodeName"> {
  return { id: target.projectId, slug: target.projectSlug, nodeName: target.nodeName };
}

export interface OrbitDraftStartInput {
  readonly project: Pick<OrbitGatewayProject, "id" | "slug" | "nodeName">;
  readonly message: string;
  readonly instanceKind: OrbitInstanceKind;
  readonly instanceName: string;
  readonly existing: OrbitExistingInstance | null;
  readonly modelSelection: ModelSelection | null;
  readonly runtimeMode: RuntimeMode;
  readonly interactionMode: ProviderInteractionMode;
  readonly projectName?: string;
  readonly instanceDomainSuffix?: string | null;
}

/** What the composer hands to the start machine for an Orbit draft. */
export function buildOrbitDraftStart(input: {
  readonly target: OrbitDraftTarget;
  readonly message: string;
  readonly modelSelection: ModelSelection | null;
  readonly runtimeMode: RuntimeMode;
  readonly interactionMode: ProviderInteractionMode;
}): OrbitDraftStartInput {
  const { target } = input;
  return {
    project: orbitDraftGatewayProject(target),
    message: input.message,
    instanceKind: target.instanceKind,
    instanceName: target.instanceName,
    existing:
      target.instanceKind === "existing" && target.existing !== null
        ? {
            instanceId: target.existing.instanceId,
            environmentId: target.existing.environmentId,
            name: target.instanceName,
            nodeName: target.nodeName,
          }
        : null,
    modelSelection: input.modelSelection,
    runtimeMode: input.runtimeMode,
    interactionMode: input.interactionMode,
    projectName: target.projectName,
    instanceDomainSuffix: target.domainSuffix,
  };
}
