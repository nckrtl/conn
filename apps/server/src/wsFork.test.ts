import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import {
  AuthOrchestrationReadScope,
  AuthOrchestrationOperateScope,
  AuthPreviewOperateScope,
  ProjectId,
  WS_METHODS,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";
import * as RpcTest from "effect/rpc/RpcTest";

import * as AnnotationStore from "./annotations/AnnotationStore.ts";
import * as RpcAuthorization from "./auth/RpcAuthorization.ts";
import * as ServerConfig from "./config.ts";
import { rpcInstrumentationLayer } from "./observability/RpcInstrumentation.ts";
import * as ProjectService from "./project/ProjectService.ts";
import * as WsFork from "./wsFork.ts";

it.effect("serves annotation queues only with their required scopes", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const baseDir = yield* fs.makeTempDirectoryScoped();
    const projectId = ProjectId.make("fork-rpc-project");
    const annotations = yield* AnnotationStore.AnnotationStore.pipe(
      Effect.provide(
        AnnotationStore.layer.pipe(
          Layer.provide(
            Layer.mergeAll(
              ServerConfig.layerTest(process.cwd(), baseDir),
              Layer.mock(ProjectService.ProjectService)({
                getById: () => Effect.succeedSome({ id: projectId } as never),
              }),
            ),
          ),
        ),
      ),
    );
    const handlers = WsFork.layer.pipe(
      Layer.provide(Layer.succeed(AnnotationStore.AnnotationStore, annotations)),
    );
    const makeClient = (scopes: Parameters<typeof RpcAuthorization.layer>[0]) =>
      RpcTest.makeClient(WsFork.ForkServerWsRpcGroup).pipe(
        Effect.provide(
          Layer.mergeAll(handlers, RpcAuthorization.layer(scopes), rpcInstrumentationLayer),
        ),
      );
    const reader = yield* makeClient([AuthOrchestrationReadScope]);
    const create = {
      projectId,
      annotation: {
        id: "browser-1",
        comment: "Fix checkout",
        source: "browser" as const,
        url: "https://shop.test/cart",
      },
    };
    expect(yield* reader[WS_METHODS.annotationsCreate](create).pipe(Effect.flip)).toMatchObject({
      _tag: "EnvironmentAuthorizationError",
      requiredPermission: AuthPreviewOperateScope,
    });
    expect(
      yield* reader[WS_METHODS.annotationsRemove]({ projectId, ids: ["browser-1"] }).pipe(
        Effect.flip,
      ),
    ).toMatchObject({ _tag: "EnvironmentAuthorizationError" });
    expect(yield* annotations.list(projectId)).toEqual({ annotations: [] });
    const operator = yield* makeClient([
      AuthOrchestrationReadScope,
      AuthOrchestrationOperateScope,
      AuthPreviewOperateScope,
    ]);
    const created = yield* operator[WS_METHODS.annotationsCreate](create);
    expect(created.annotation).toMatchObject({ id: "browser-1", number: 1, status: "todo" });
    expect(
      yield* reader[WS_METHODS.annotationsSubscribe]({ projectId }).pipe(Stream.runHead),
    ).toEqual(Option.some({ annotations: [created.annotation] }));
    expect(
      yield* operator[WS_METHODS.annotationsRemove]({ projectId, ids: ["browser-1"] }),
    ).toEqual({ removedIds: ["browser-1"] });
    expect(yield* annotations.list(projectId)).toEqual({ annotations: [] });
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);
