import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import { type AnnotationCapture, ProjectId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Queue from "effect/Queue";
import * as Stream from "effect/Stream";

import * as ServerConfig from "../config.ts";
import * as ProjectService from "../project/ProjectService.ts";
import * as AnnotationStore from "./AnnotationStore.ts";

const projectId = ProjectId.make("project:shop");
const otherProject = ProjectId.make("project:other");

const capture = (id: string, comment = `Fix ${id}`): AnnotationCapture => ({
  id,
  comment,
  url: "http://shop.test/cart",
  element: "button.checkout",
});

const openStore = (baseDir: string) =>
  AnnotationStore.AnnotationStore.pipe(
    Effect.provide(
      AnnotationStore.layer.pipe(
        Layer.provide(
          Layer.mergeAll(
            Layer.mock(ProjectService.ProjectService)({
              getById: (id) =>
                Effect.succeed(
                  id === projectId || id === otherProject
                    ? Option.some({ id } as never)
                    : Option.none(),
                ),
            }),
            ServerConfig.layerTest(process.cwd(), baseDir),
          ),
        ),
        Layer.provideMerge(NodeServices.layer),
      ),
    ),
  );

/** A store over a fresh state directory, and a way to open it again over the same files. */
const withStore = <A, E, R>(
  use: (
    store: AnnotationStore.AnnotationStore["Service"],
    reopen: () => ReturnType<typeof openStore>,
  ) => Effect.Effect<A, E, R>,
) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const baseDir = yield* fs.realPath(
      yield* fs.makeTempDirectoryScoped({ prefix: "t3-annotation-store-" }),
    );
    return yield* use(yield* openStore(baseDir), () => openStore(baseDir));
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer));

describe("AnnotationStore", () => {
  it.effect("numbers new annotations and keeps the number when one is edited", () =>
    withStore((store) =>
      Effect.gen(function* () {
        const first = yield* store.create(projectId, capture("a"));
        const second = yield* store.create(projectId, capture("b"));
        assert.deepStrictEqual([first.number, second.number], [1, 2]);
        assert.strictEqual(first.status, "todo");
        assert.isTrue(second.revision > first.revision);

        yield* store.claim(projectId, "a");
        const edited = yield* store.create(projectId, { ...capture("a"), comment: "  Bigger  " });
        assert.strictEqual(edited.number, 1);
        assert.strictEqual(edited.comment, "Bigger");
        assert.strictEqual(edited.status, "in_progress");

        const other = yield* store.create(otherProject, capture("a"));
        assert.strictEqual(other.number, 1);
        const { annotations } = yield* store.list(projectId);
        assert.deepStrictEqual(
          annotations.map((a) => [a.id, a.number]),
          [
            ["a", 1],
            ["b", 2],
          ],
        );
      }),
    ),
  );

  it.effect("refuses an empty comment, an unknown project and a removed id", () =>
    withStore((store) =>
      Effect.gen(function* () {
        const empty = yield* store.create(projectId, capture("a", "   ")).pipe(Effect.flip);
        assert.strictEqual(empty._tag, "AnnotationInvalidError");
        const unknown = yield* store
          .create(ProjectId.make("project:gone"), capture("a"))
          .pipe(Effect.flip);
        assert.strictEqual(unknown._tag, "AnnotationProjectNotFoundError");

        yield* store.create(projectId, capture("a"));
        assert.deepStrictEqual(yield* store.remove({ projectId, ids: ["a", "missing"] }), {
          removedIds: ["a"],
        });
        const removed = yield* store.create(projectId, capture("a")).pipe(Effect.flip);
        assert.strictEqual(removed._tag, "AnnotationRemovedError");
        const next = yield* store.create(projectId, capture("b"));
        assert.strictEqual(next.number, 2);
      }),
    ),
  );

  it.effect("claims the oldest todo that is not a question, and by id only from todo", () =>
    withStore((store) =>
      Effect.gen(function* () {
        yield* store.create(projectId, capture("a"));
        yield* store.create(projectId, capture("b"));
        yield* store.create(projectId, capture("c"));

        const first = yield* store.claim(projectId);
        assert.strictEqual(Option.getOrThrow(first).id, "a");
        yield* store.release(projectId, "a", { summary: "Which colour?", question: true });

        const second = Option.getOrThrow(yield* store.claim(projectId));
        assert.strictEqual(second.id, "b");
        assert.strictEqual(second.status, "in_progress");
        assert.isDefined(second.claimedAt);

        const conflict = yield* store.claim(projectId, "b").pipe(Effect.flip);
        assert.strictEqual(conflict._tag, "AnnotationConflictError");
        const missing = yield* store.claim(projectId, "zzz").pipe(Effect.flip);
        assert.strictEqual(missing._tag, "AnnotationNotFoundError");

        assert.strictEqual(Option.getOrThrow(yield* store.claim(projectId)).id, "c");
        assert.isTrue(Option.isNone(yield* store.claim(projectId)));

        const answered = Option.getOrThrow(yield* store.claim(projectId, "a"));
        assert.strictEqual(answered.status, "in_progress");
        assert.isUndefined(answered.question);
        assert.isUndefined(answered.summary);
      }),
    ),
  );

  it.effect("completes and releases idempotently and only from in progress", () =>
    withStore((store) =>
      Effect.gen(function* () {
        yield* store.create(projectId, capture("a"));
        yield* store.create(projectId, capture("b"));

        const early = yield* store.complete(projectId, "a", "Done").pipe(Effect.flip);
        assert.strictEqual(early._tag, "AnnotationConflictError");
        const unchanged = yield* store.release(projectId, "a", { summary: "Blocked" });
        assert.strictEqual(unchanged.status, "todo");
        assert.isUndefined(unchanged.summary);

        yield* store.claim(projectId, "a");
        const done = yield* store.complete(projectId, "a", "Made it bigger; lint passes.");
        assert.strictEqual(done.status, "done");
        assert.isDefined(done.completedAt);
        const again = yield* store.complete(projectId, "a", "Other");
        assert.deepStrictEqual(again, done);
        const late = yield* store.release(projectId, "a").pipe(Effect.flip);
        assert.strictEqual(late._tag, "AnnotationConflictError");

        yield* store.claim(projectId, "b");
        const question = yield* store
          .release(projectId, "b", { question: true, summary: "  " })
          .pipe(Effect.flip);
        assert.strictEqual(question._tag, "AnnotationInvalidError");
        const released = yield* store.release(projectId, "b", { summary: "Tests are red." });
        assert.strictEqual(released.status, "todo");
        assert.strictEqual(released.summary, "Tests are red.");
        assert.isUndefined(released.claimedAt);
        assert.isUndefined(released.question);
      }),
    ),
  );

  it.effect("removes done ones, or everything not in progress", () =>
    withStore((store) =>
      Effect.gen(function* () {
        for (const id of ["a", "b", "c"]) yield* store.create(projectId, capture(id));
        yield* store.claim(projectId, "a");
        yield* store.complete(projectId, "a");
        yield* store.claim(projectId, "b");

        assert.deepStrictEqual(yield* store.remove({ projectId, scope: "done" }), {
          removedIds: ["a"],
        });
        assert.deepStrictEqual(yield* store.remove({ projectId, scope: "idle" }), {
          removedIds: ["c"],
        });
        const { annotations } = yield* store.list(projectId);
        assert.deepStrictEqual(
          annotations.map((a) => a.id),
          ["b"],
        );
      }),
    ),
  );

  it.effect("reloads records, numbers and removals from disk", () =>
    withStore((store, reopen) =>
      Effect.gen(function* () {
        yield* store.create(projectId, capture("a"));
        yield* store.create(projectId, capture("b"));
        yield* store.claim(projectId, "b");
        yield* store.remove({ projectId, ids: ["a"] });
        const before = yield* store.list(projectId);

        const reopened = yield* reopen();
        assert.deepStrictEqual(yield* reopened.list(projectId), before);
        const next = yield* reopened.create(projectId, capture("c"));
        assert.strictEqual(next.number, 3);
        assert.isTrue(next.revision > before.annotations[0]!.revision);
        const removed = yield* reopened.create(projectId, capture("a")).pipe(Effect.flip);
        assert.strictEqual(removed._tag, "AnnotationRemovedError");
      }),
    ),
  );

  it.effect("stores the screenshot as a file and returns its path", () =>
    withStore((store) =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const bytes = Buffer.from("not really a png");
        const record = yield* store.create(projectId, {
          ...capture("a"),
          screenshot: `data:image/png;base64,${bytes.toString("base64")}`,
        });
        assert.isTrue(record.hasScreenshot);
        assert.notProperty(record, "screenshot");

        const file = Option.getOrThrow(yield* store.screenshotPath(projectId, "a"));
        assert.isTrue(file.endsWith("a.png"));
        assert.deepStrictEqual(Buffer.from(yield* fs.readFile(file)), bytes);
        assert.isTrue(Option.isNone(yield* store.screenshotPath(projectId, "missing")));

        const invalid = yield* store
          .create(projectId, { ...capture("b"), screenshot: "data:text/plain;base64,aGk=" })
          .pipe(Effect.flip);
        assert.strictEqual(invalid._tag, "AnnotationInvalidError");

        yield* store.remove({ projectId, ids: ["a"] });
        assert.isFalse(yield* fs.exists(file));
      }),
    ),
  );

  it.effect("streams the list on subscribe and after each change in the project", () =>
    withStore((store) =>
      Effect.gen(function* () {
        const lists = yield* Queue.unbounded<ReadonlyArray<string>>();
        const fiber = yield* store.subscribe(projectId).pipe(
          Stream.runForEach((list) =>
            Queue.offer(
              lists,
              list.annotations.map((a) => `${a.id}:${a.status}`),
            ),
          ),
          Effect.forkScoped,
        );
        assert.deepStrictEqual(yield* Queue.take(lists), []);

        yield* store.create(otherProject, capture("elsewhere"));
        yield* store.create(projectId, capture("a"));
        assert.deepStrictEqual(yield* Queue.take(lists), ["a:todo"]);
        yield* store.claim(projectId);
        assert.deepStrictEqual(yield* Queue.take(lists), ["a:in_progress"]);
        yield* Fiber.interrupt(fiber);
      }),
    ),
  );
});
