import { mFallback, msg } from "gt-i18n";
import type { MFunctionType } from "gt-i18n/types";

import type { OrbitLaunch, OrbitLaunchAction, OrbitLaunchStage } from "./launches.ts";

export const ORBIT_LAUNCH_STAGES = {
  workspace_server: msg("Prepare workspace and server"),
  first_message: msg("Send first message"),
  publication: msg("Attach thread to profile"),
  application_preview: msg("Prepare application preview"),
  cleanup: msg("Clean up launch"),
} satisfies Record<keyof OrbitLaunch["stages"], string>;

export const ORBIT_LAUNCH_PHASE_LABELS = {
  preparing: msg("Preparing instance"),
  dispatching: msg("Sending first message"),
  publishing: msg("Attaching thread"),
  ready: msg("Thread ready"),
  needs_retry: msg("Launch needs attention"),
  cancelling: msg("Cancelling"),
  cancelled: msg("Cancelled", { $context: "launch phase" }),
} satisfies Record<OrbitLaunch["phase"], string>;

export const ORBIT_LAUNCH_STAGE_STATUS = {
  pending: msg("Waiting", { $context: "launch stage status" }),
  running: msg("In progress", { $context: "launch stage status" }),
  succeeded: msg("Done", { $context: "launch stage status" }),
  failed: msg("Failed", { $context: "launch stage status" }),
  cancelled: msg("Cancelled", { $context: "launch stage status" }),
  skipped: msg("Skipped", { $context: "launch stage status" }),
} satisfies Record<OrbitLaunchStage["status"], string>;

export const ORBIT_LAUNCH_ACTION_LABELS = {
  cancel: msg("Cancel launch"),
  retry_launch: msg("Retry launch"),
  retry_application: msg("Retry application"),
} satisfies Record<OrbitLaunchAction, string>;

export function orbitLaunchActionLabel(
  action: OrbitLaunchAction,
  phase: OrbitLaunch["phase"],
  resolve: MFunctionType = mFallback,
) {
  return resolve(
    action === "retry_launch" && phase === "cancelling"
      ? msg("Retry cleanup")
      : ORBIT_LAUNCH_ACTION_LABELS[action],
  );
}
