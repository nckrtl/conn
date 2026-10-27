import {
  type AnnotationCapture,
  AnnotationConflictError,
  AnnotationId,
  AnnotationInvalidError,
  type AnnotationList,
  AnnotationNotFoundError,
  AnnotationProjectNotFoundError,
  AnnotationRecord,
  type AnnotationRemoveInput,
  type AnnotationRemoveResult,
  AnnotationRemovedError,
  type AnnotationStatus,
  AnnotationStoreError,
  type ProjectId,
} from "@t3tools/contracts";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as PubSub from "effect/PubSub";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";

import { ServerConfig } from "../config.ts";
import * as ProjectService from "../project/ProjectService.ts";

// Fork patch: plain files, not SQLite, because fork migration ids collide with upstream's.
// Layout per project: `<id>.json` records, `<id>.<ext>` screenshots, and `_sequence.json`
// and `_deleted.json`, whose leading `_` no annotation id can have.

const Sequence = Schema.Struct({ lastNumber: Schema.Number, revision: Schema.Number });
const decodeSequence = Schema.decodeUnknownEffect(Schema.fromJsonString(Sequence));
const decodeDeleted = Schema.decodeUnknownEffect(Schema.fromJsonString(Schema.Array(AnnotationId)));
const decodeRecord = Schema.decodeUnknownEffect(Schema.fromJsonString(AnnotationRecord));
const encodeSequence = Schema.encodeEffect(Schema.fromJsonString(Sequence));
const encodeDeleted = Schema.encodeEffect(Schema.fromJsonString(Schema.Array(AnnotationId)));
const encodeRecord = Schema.encodeEffect(Schema.fromJsonString(AnnotationRecord));

const SCREENSHOT_EXTENSIONS = ["jpg", "png", "webp"] as const;
type ScreenshotExtension = (typeof SCREENSHOT_EXTENSIONS)[number];
const SCREENSHOT_DATA_URL = /^data:image\/(png|jpe?g|webp);base64,([A-Za-z0-9+/=\s]+)$/;

type AnnotationStoreFailure = AnnotationProjectNotFoundError | AnnotationStoreError;

export class AnnotationStore extends Context.Service<
  AnnotationStore,
  {
    readonly list: (projectId: ProjectId) => Effect.Effect<AnnotationList, AnnotationStoreFailure>;
    /** The list on subscribe, then the full list after every change in the project. */
    readonly subscribe: (
      projectId: ProjectId,
    ) => Stream.Stream<AnnotationList, AnnotationStoreFailure>;
    /** An existing id takes the new capture and keeps its number and status. */
    readonly create: (
      projectId: ProjectId,
      capture: AnnotationCapture,
    ) => Effect.Effect<
      AnnotationRecord,
      AnnotationStoreFailure | AnnotationRemovedError | AnnotationInvalidError
    >;
    readonly remove: (
      input: AnnotationRemoveInput,
    ) => Effect.Effect<AnnotationRemoveResult, AnnotationStoreFailure>;
    /** Without an id, the oldest todo that is not a question; none when nothing waits. */
    readonly claim: (
      projectId: ProjectId,
      id?: AnnotationId,
    ) => Effect.Effect<
      Option.Option<AnnotationRecord>,
      AnnotationStoreFailure | AnnotationNotFoundError | AnnotationConflictError
    >;
    readonly complete: (
      projectId: ProjectId,
      id: AnnotationId,
      summary?: string,
    ) => Effect.Effect<
      AnnotationRecord,
      AnnotationStoreFailure | AnnotationNotFoundError | AnnotationConflictError
    >;
    readonly release: (
      projectId: ProjectId,
      id: AnnotationId,
      options?: { readonly summary?: string | undefined; readonly question?: boolean | undefined },
    ) => Effect.Effect<
      AnnotationRecord,
      | AnnotationStoreFailure
      | AnnotationNotFoundError
      | AnnotationConflictError
      | AnnotationInvalidError
    >;
    readonly screenshotPath: (
      projectId: ProjectId,
      id: AnnotationId,
    ) => Effect.Effect<Option.Option<string>, AnnotationStoreFailure>;
  }
>()("t3/annotations/AnnotationStore") {}

interface ProjectData {
  readonly directory: string;
  lastNumber: number;
  revision: number;
  deleted: ReadonlySet<string>;
  readonly records: Map<string, AnnotationRecord>;
}

interface ProjectEntry {
  readonly lock: Semaphore.Semaphore;
  readonly changes: PubSub.PubSub<void>;
  data: ProjectData | undefined;
}

const storeError = (reason: string) => (cause: unknown) =>
  new AnnotationStoreError({ reason, cause });

const sortedList = (data: ProjectData): AnnotationList => ({
  annotations: [...data.records.values()].toSorted((a, b) => a.number - b.number),
});

const decodeScreenshot = (dataUrl: string) => {
  const match = SCREENSHOT_DATA_URL.exec(dataUrl);
  if (match === null) return undefined;
  const extension: ScreenshotExtension =
    match[1] === "png" ? "png" : match[1] === "webp" ? "webp" : "jpg";
  return { extension, bytes: new Uint8Array(Buffer.from(match[2]!, "base64")) };
};

const make = Effect.gen(function* () {
  const config = yield* ServerConfig;
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const projects = yield* ProjectService.ProjectService;
  const entries = new Map<ProjectId, ProjectEntry>();
  const registryLock = yield* Semaphore.make(1);

  const directoryFor = (projectId: ProjectId) =>
    path.join(config.stateDir, "annotations", projectId.replace(/[^A-Za-z0-9._-]/g, "_"));
  const recordPath = (data: ProjectData, id: string) => path.join(data.directory, `${id}.json`);
  const screenshotFile = (data: ProjectData, id: string, extension: ScreenshotExtension) =>
    path.join(data.directory, `${id}.${extension}`);

  const writeAtomically = (file: string, contents: string | Uint8Array) => {
    const temp = `${file}.tmp`;
    return (
      typeof contents === "string"
        ? fs.writeFileString(temp, contents)
        : fs.writeFile(temp, contents)
    ).pipe(Effect.andThen(fs.rename(temp, file)));
  };

  const removeScreenshots = (data: ProjectData, id: string, keep?: ScreenshotExtension) =>
    Effect.forEach(
      SCREENSHOT_EXTENSIONS.filter((extension) => extension !== keep),
      (extension) => fs.remove(screenshotFile(data, id, extension), { force: true }),
      { discard: true },
    );

  const readIfExists = (file: string) =>
    fs
      .exists(file)
      .pipe(
        Effect.flatMap((exists) =>
          exists ? fs.readFileString(file).pipe(Effect.asSome) : Effect.succeedNone,
        ),
      );

  const load = Effect.fn("AnnotationStore.load")(function* (projectId: ProjectId) {
    const directory = directoryFor(projectId);
    yield* fs.makeDirectory(directory, { recursive: true });
    const sequence = yield* readIfExists(path.join(directory, "_sequence.json")).pipe(
      Effect.flatMap(
        Option.match({
          onNone: () => Effect.succeed({ lastNumber: 0, revision: 0 }),
          onSome: decodeSequence,
        }),
      ),
    );
    const deleted = yield* readIfExists(path.join(directory, "_deleted.json")).pipe(
      Effect.flatMap(
        Option.match({
          onNone: () => Effect.succeed([] as ReadonlyArray<string>),
          onSome: decodeDeleted,
        }),
      ),
    );
    const data: ProjectData = {
      directory,
      lastNumber: sequence.lastNumber,
      revision: sequence.revision,
      deleted: new Set(deleted),
      records: new Map(),
    };
    const names = yield* fs.readDirectory(directory);
    for (const name of names) {
      if (!name.endsWith(".json") || name.startsWith("_")) continue;
      const id = name.slice(0, -".json".length);
      if (data.deleted.has(id)) {
        // A removal that stopped before it deleted the files.
        yield* fs.remove(recordPath(data, id), { force: true });
        yield* removeScreenshots(data, id);
        continue;
      }
      const record = yield* fs.readFileString(path.join(directory, name)).pipe(
        Effect.flatMap(decodeRecord),
        Effect.tapError((cause) =>
          Effect.logWarning("Skipped an unreadable annotation file.", { file: name, cause }),
        ),
        Effect.option,
      );
      if (Option.isNone(record) || record.value.id !== id) continue;
      data.records.set(id, record.value);
      data.lastNumber = Math.max(data.lastNumber, record.value.number);
      data.revision = Math.max(data.revision, record.value.revision);
    }
    return data;
  });

  const requireProject = Effect.fn("AnnotationStore.requireProject")(function* (
    projectId: ProjectId,
  ) {
    const project = yield* projects
      .getById(projectId)
      .pipe(Effect.mapError(storeError("Could not read the project.")));
    if (Option.isNone(project)) return yield* new AnnotationProjectNotFoundError({ projectId });
  });

  const entryFor = (projectId: ProjectId) =>
    registryLock.withPermits(1)(
      Effect.gen(function* () {
        const existing = entries.get(projectId);
        if (existing !== undefined) return existing;
        const entry: ProjectEntry = {
          lock: yield* Semaphore.make(1),
          changes: yield* PubSub.sliding<void>(1),
          data: undefined,
        };
        entries.set(projectId, entry);
        return entry;
      }),
    );

  const loaded = (projectId: ProjectId, entry: ProjectEntry) =>
    entry.data !== undefined
      ? Effect.succeed(entry.data)
      : load(projectId).pipe(
          Effect.tap((data) =>
            Effect.sync(() => {
              entry.data = data;
            }),
          ),
          Effect.mapError(storeError("Could not read the annotations.")),
        );

  /** Runs `use` alone in the project and tells subscribers when it changed the revision. */
  const withProject = <A, E>(
    projectId: ProjectId,
    use: (data: ProjectData) => Effect.Effect<A, E>,
  ): Effect.Effect<A, E | AnnotationStoreFailure> =>
    requireProject(projectId).pipe(
      Effect.andThen(entryFor(projectId)),
      Effect.flatMap((entry) =>
        loaded(projectId, entry).pipe(
          Effect.flatMap((data) => {
            const before = data.revision;
            return use(data).pipe(
              Effect.map((result) => ({ result, changed: data.revision !== before })),
            );
          }),
          entry.lock.withPermits(1),
          Effect.tap(({ changed }) =>
            changed ? PubSub.publish(entry.changes, undefined) : Effect.void,
          ),
          Effect.map(({ result }) => result),
        ),
      ),
    );

  const nowIso = Clock.currentTimeMillis.pipe(
    Effect.map((millis) => DateTime.formatIso(DateTime.makeUnsafe(millis))),
  );

  const saveSequence = Effect.fn("AnnotationStore.saveSequence")(function* (
    data: ProjectData,
    sequence: typeof Sequence.Type,
  ) {
    yield* writeAtomically(
      path.join(data.directory, "_sequence.json"),
      yield* encodeSequence(sequence),
    );
    data.lastNumber = sequence.lastNumber;
    data.revision = sequence.revision;
  });

  /** Writes the record with the next revision, then commits it in memory. */
  const save = Effect.fn("AnnotationStore.save")(
    function* (data: ProjectData, record: AnnotationRecord, lastNumber = data.lastNumber) {
      const revision = data.revision + 1;
      const next: AnnotationRecord = { ...record, revision };
      yield* writeAtomically(recordPath(data, next.id), yield* encodeRecord(next));
      yield* saveSequence(data, { lastNumber, revision });
      data.records.set(next.id, next);
      return next;
    },
    Effect.mapError(storeError("Could not save the annotation.")),
  );

  const find = (projectId: ProjectId, data: ProjectData, id: AnnotationId) => {
    const record = data.records.get(id);
    return record === undefined
      ? Effect.fail(new AnnotationNotFoundError({ projectId, id }))
      : Effect.succeed(record);
  };

  const requireStatus = (record: AnnotationRecord, expected: AnnotationStatus) =>
    record.status === expected
      ? Effect.void
      : Effect.fail(
          new AnnotationConflictError({ id: record.id, status: record.status, expected }),
        );

  const list: AnnotationStore["Service"]["list"] = Effect.fn("AnnotationStore.list")(
    function* (projectId) {
      return yield* withProject(projectId, (data) => Effect.succeed(sortedList(data)));
    },
  );

  const subscribe: AnnotationStore["Service"]["subscribe"] = (projectId) =>
    Stream.unwrap(
      Effect.gen(function* () {
        yield* requireProject(projectId);
        const entry = yield* entryFor(projectId);
        // Subscribe before reading to buffer concurrent changes.
        const subscription = yield* PubSub.subscribe(entry.changes);
        return Stream.concat(
          Stream.fromEffect(list(projectId)),
          Stream.fromSubscription(subscription).pipe(Stream.mapEffect(() => list(projectId))),
        );
      }),
    );

  const create: AnnotationStore["Service"]["create"] = Effect.fn("AnnotationStore.create")(
    function* (projectId, capture) {
      const { screenshot, ...fields } = capture;
      const comment = fields.comment.trim();
      if (comment === "")
        return yield* new AnnotationInvalidError({ reason: "An annotation needs a comment." });
      const image = screenshot === undefined ? undefined : decodeScreenshot(screenshot);
      if (screenshot !== undefined && image === undefined)
        return yield* new AnnotationInvalidError({
          reason: "The screenshot must be a base64 PNG, JPEG or WebP data URL.",
        });
      const now = yield* nowIso;
      return yield* withProject(projectId, (data) =>
        Effect.gen(function* () {
          if (data.deleted.has(fields.id))
            return yield* new AnnotationRemovedError({ id: fields.id });
          const existing = data.records.get(fields.id);
          if (image !== undefined) {
            yield* writeAtomically(
              screenshotFile(data, fields.id, image.extension),
              image.bytes,
            ).pipe(
              Effect.andThen(removeScreenshots(data, fields.id, image.extension)),
              Effect.mapError(storeError("Could not save the screenshot.")),
            );
          }
          const number = existing?.number ?? data.lastNumber + 1;
          return yield* save(
            data,
            {
              ...fields,
              comment,
              projectId,
              number,
              revision: data.revision,
              status: existing?.status ?? "todo",
              hasScreenshot: image !== undefined || existing?.hasScreenshot === true,
              createdAt: existing?.createdAt ?? now,
              ...(existing?.summary === undefined ? {} : { summary: existing.summary }),
              ...(existing?.question === undefined ? {} : { question: existing.question }),
              ...(existing?.claimedAt === undefined ? {} : { claimedAt: existing.claimedAt }),
              ...(existing?.completedAt === undefined ? {} : { completedAt: existing.completedAt }),
            },
            Math.max(data.lastNumber, number),
          );
        }),
      );
    },
  );

  const remove: AnnotationStore["Service"]["remove"] = Effect.fn("AnnotationStore.remove")(
    function* ({ projectId, ids, scope }) {
      return yield* withProject(projectId, (data) =>
        Effect.gen(function* () {
          const candidates =
            ids === undefined
              ? [...data.records.values()]
              : ids.flatMap((id) => {
                  const record = data.records.get(id);
                  return record === undefined ? [] : [record];
                });
          const removed = candidates.filter((record) =>
            scope === "done"
              ? record.status === "done"
              : scope === "idle"
                ? record.status !== "in_progress"
                : true,
          );
          if (removed.length === 0) return { removedIds: [] };
          const removedIds = removed.map((record) => record.id);
          const deleted = new Set([...data.deleted, ...removedIds]);
          // Remember the ids first, so a stopped removal finishes on the next load.
          yield* writeAtomically(
            path.join(data.directory, "_deleted.json"),
            yield* encodeDeleted([...deleted]),
          );
          data.deleted = deleted;
          yield* saveSequence(data, { lastNumber: data.lastNumber, revision: data.revision + 1 });
          for (const id of removedIds) {
            data.records.delete(id);
            yield* fs.remove(recordPath(data, id), { force: true });
            yield* removeScreenshots(data, id);
          }
          return { removedIds };
        }).pipe(Effect.mapError(storeError("Could not remove the annotations."))),
      );
    },
  );

  const claim: AnnotationStore["Service"]["claim"] = Effect.fn("AnnotationStore.claim")(
    function* (projectId, id) {
      const now = yield* nowIso;
      return yield* withProject(projectId, (data) =>
        Effect.gen(function* () {
          let target: AnnotationRecord | undefined;
          if (id === undefined) {
            target = sortedList(data).annotations.find(
              (record) => record.status === "todo" && record.question !== true,
            );
            if (target === undefined) return Option.none();
          } else {
            target = yield* find(projectId, data, id);
            yield* requireStatus(target, "todo");
          }
          // A claim by id answers a question, so its marker and question go.
          const { question, summary, completedAt: _completedAt, ...rest } = target;
          return Option.some(
            yield* save(data, {
              ...rest,
              ...(question === true || summary === undefined ? {} : { summary }),
              status: "in_progress",
              claimedAt: now,
            }),
          );
        }),
      );
    },
  );

  const complete: AnnotationStore["Service"]["complete"] = Effect.fn("AnnotationStore.complete")(
    function* (projectId, id, summary) {
      const now = yield* nowIso;
      return yield* withProject(projectId, (data) =>
        Effect.gen(function* () {
          const current = yield* find(projectId, data, id);
          if (current.status === "done") return current;
          yield* requireStatus(current, "in_progress");
          const text = summary?.trim();
          return yield* save(data, {
            ...current,
            ...(text === undefined || text === "" ? {} : { summary: text }),
            status: "done",
            completedAt: now,
          });
        }),
      );
    },
  );

  const release: AnnotationStore["Service"]["release"] = Effect.fn("AnnotationStore.release")(
    function* (projectId, id, options = {}) {
      const text = options.summary?.trim();
      const question = options.question === true;
      if (question && (text === undefined || text === ""))
        return yield* new AnnotationInvalidError({
          reason: "A question needs the question as summary.",
        });
      return yield* withProject(projectId, (data) =>
        Effect.gen(function* () {
          const current = yield* find(projectId, data, id);
          if (current.status === "todo") return current;
          yield* requireStatus(current, "in_progress");
          const {
            claimedAt: _claimedAt,
            completedAt: _completedAt,
            question: _question,
            ...rest
          } = current;
          return yield* save(data, {
            ...rest,
            ...(text === undefined || text === "" ? {} : { summary: text }),
            ...(question ? { question: true } : {}),
            status: "todo",
          });
        }),
      );
    },
  );

  const screenshotPath: AnnotationStore["Service"]["screenshotPath"] = Effect.fn(
    "AnnotationStore.screenshotPath",
  )(function* (projectId, id) {
    return yield* withProject(projectId, (data) =>
      Effect.gen(function* () {
        if (data.records.get(id)?.hasScreenshot !== true) return Option.none();
        for (const extension of SCREENSHOT_EXTENSIONS) {
          const file = screenshotFile(data, id, extension);
          if (yield* fs.exists(file)) return Option.some(file);
        }
        return Option.none();
      }).pipe(Effect.mapError(storeError("Could not read the screenshot."))),
    );
  });

  return AnnotationStore.of({
    list,
    subscribe,
    create,
    remove,
    claim,
    complete,
    release,
    screenshotPath,
  });
});

export const layer = Layer.effect(AnnotationStore, make);
