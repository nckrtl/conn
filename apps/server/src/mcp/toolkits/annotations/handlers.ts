import { OrchestratorMcpFailure } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

import * as AnnotationStore from "../../../annotations/AnnotationStore.ts";
import * as ThreadManagementService from "../../../orchestration-v2/ThreadManagementService.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";
import * as McpToolAccess from "../../McpToolAccess.ts";
import { AnnotationsToolkit } from "./tools.ts";

/** Annotations belong to the calling thread's project. */
const callerProject = Effect.fn("AnnotationsToolkit.callerProject")(function* () {
  const scope = yield* McpInvocationContext.McpInvocationContext;
  const thread = yield* McpInvocationContext.requireThreadScope(scope, "Annotations");
  const threads = yield* ThreadManagementService.ThreadManagementService;
  const shell = yield* threads
    .getThreadShell(thread.thread.threadId)
    .pipe(Effect.orElseSucceed(() => null));
  if (shell === null)
    return yield* new OrchestratorMcpFailure({
      code: "thread_not_found",
      message: "The calling thread is gone.",
    });
  return { projectId: shell.projectId, store: yield* AnnotationStore.AnnotationStore };
});

export const layer = McpToolAccess.toLayer(AnnotationsToolkit, {
  annotations_list: McpToolAccess.readsAsCaller(({ all }) =>
    Effect.gen(function* () {
      const { projectId, store } = yield* callerProject();
      const { annotations } = yield* store.list(projectId);
      return {
        annotations: all === true ? annotations : annotations.filter((a) => a.status !== "done"),
      };
    }),
  ),
  annotations_claim: McpToolAccess.actsAsCaller(({ id }) =>
    Effect.gen(function* () {
      const { projectId, store } = yield* callerProject();
      const claimed = yield* store.claim(projectId, id);
      if (Option.isNone(claimed)) return { annotation: null };
      const screenshotPath = yield* store.screenshotPath(projectId, claimed.value.id);
      return {
        annotation: Option.isSome(screenshotPath)
          ? { ...claimed.value, screenshotPath: screenshotPath.value }
          : claimed.value,
      };
    }),
  ),
  annotations_complete: McpToolAccess.actsAsCaller(({ id, summary }) =>
    Effect.gen(function* () {
      const { projectId, store } = yield* callerProject();
      return { annotation: yield* store.complete(projectId, id, summary) };
    }),
  ),
  annotations_release: McpToolAccess.actsAsCaller(({ id, summary, question }) =>
    Effect.gen(function* () {
      const { projectId, store } = yield* callerProject();
      return { annotation: yield* store.release(projectId, id, { summary, question }) };
    }),
  ),
});
