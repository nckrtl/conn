import { ForkWsRpcGroup, RpcScopeAuthorization, WS_METHODS } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as RpcGroup from "effect/rpc/RpcGroup";

import * as AnnotationStore from "./annotations/AnnotationStore.ts";
import { RpcInstrumentation } from "./observability/RpcInstrumentation.ts";

// Keep this allowlist separate from the larger upstream handler groups to bound type expansion.
const featureTags = [
  WS_METHODS.annotationsSubscribe,
  WS_METHODS.annotationsCreate,
  WS_METHODS.annotationsRemove,
] as const;
type ForkRpc = RpcGroup.Rpcs<typeof ForkWsRpcGroup>;
type FeatureRpc = Extract<ForkRpc, { readonly _tag: (typeof featureTags)[number] }>;
export const ForkServerWsRpcGroup = RpcGroup.make(
  ...[...ForkWsRpcGroup.requests.values()].filter((rpc): rpc is FeatureRpc =>
    featureTags.some((tag) => tag === rpc._tag),
  ),
)
  .middleware(RpcScopeAuthorization)
  .middleware(RpcInstrumentation);

export const layer = ForkServerWsRpcGroup.toLayer(
  Effect.gen(function* () {
    const annotations = yield* AnnotationStore.AnnotationStore;
    return ForkServerWsRpcGroup.of({
      [WS_METHODS.annotationsSubscribe]: (input) => annotations.subscribe(input.projectId),
      [WS_METHODS.annotationsCreate]: (input) =>
        annotations
          .create(input.projectId, input.annotation)
          .pipe(Effect.map((annotation) => ({ annotation }))),
      [WS_METHODS.annotationsRemove]: (input) => annotations.remove(input),
    });
  }),
);
