import {
  type SaveTestLoginInput,
  TestLoginNotFoundError,
  TestLoginStoreError,
  type TestLoginSecrets,
  type TestLoginSummary,
  type UpdateTestLoginInput,
} from "@t3tools/contracts";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";

import * as ServerSecretStore from "../auth/ServerSecretStore.ts";

/**
 * T3 Code's own logins for test users of sites you develop. They live in the
 * environment's secrets folder (owner-only permissions), so agents running
 * here can save the users they create and sign in with them later.
 */

const StoredTestLogin = Schema.Struct({
  id: Schema.String,
  label: Schema.String,
  url: Schema.String,
  username: Schema.String,
  password: Schema.String,
  otpSecret: Schema.NullOr(Schema.String),
  createdAt: Schema.String,
  createdBy: Schema.Literals(["user", "agent"]),
});
export type StoredTestLogin = typeof StoredTestLogin.Type;

const StoredTestLogins = Schema.Struct({
  version: Schema.Literal(1),
  logins: Schema.Array(StoredTestLogin),
});
const decodeStored = Schema.decodeUnknownEffect(Schema.fromJsonString(StoredTestLogins));
const encodeStored = Schema.encodeEffect(Schema.fromJsonString(StoredTestLogins));

const SECRET_NAME = "test-logins";

export const summarizeTestLogin = (login: StoredTestLogin): TestLoginSummary => ({
  id: login.id,
  label: login.label,
  url: login.url,
  username: login.username,
  hasOtp: login.otpSecret !== null,
  createdAt: login.createdAt,
  createdBy: login.createdBy,
});

export class TestLoginStore extends Context.Service<
  TestLoginStore,
  {
    readonly list: Effect.Effect<ReadonlyArray<StoredTestLogin>, TestLoginStoreError>;
    readonly save: (
      input: SaveTestLoginInput,
      createdBy: StoredTestLogin["createdBy"],
    ) => Effect.Effect<TestLoginSummary, TestLoginStoreError>;
    readonly update: (
      input: UpdateTestLoginInput,
    ) => Effect.Effect<TestLoginSummary, TestLoginStoreError | TestLoginNotFoundError>;
    readonly remove: (
      id: string,
    ) => Effect.Effect<void, TestLoginStoreError | TestLoginNotFoundError>;
    readonly reveal: (
      id: string,
    ) => Effect.Effect<TestLoginSecrets, TestLoginStoreError | TestLoginNotFoundError>;
  }
>()("t3/credentials/TestLoginStore") {}

const make = Effect.gen(function* () {
  const secrets = yield* ServerSecretStore.ServerSecretStore;
  const crypto = yield* Crypto.Crypto;
  const writes = yield* Semaphore.make(1);

  const read = secrets.get(SECRET_NAME).pipe(
    Effect.flatMap(
      Option.match({
        onNone: () => Effect.succeed([] as ReadonlyArray<StoredTestLogin>),
        onSome: (bytes) =>
          decodeStored(new TextDecoder().decode(bytes)).pipe(Effect.map((file) => file.logins)),
      }),
    ),
    Effect.mapError((cause) => new TestLoginStoreError({ cause })),
  );

  const write = (logins: ReadonlyArray<StoredTestLogin>) =>
    encodeStored({ version: 1, logins }).pipe(
      Effect.flatMap((json) => secrets.set(SECRET_NAME, new TextEncoder().encode(json))),
      Effect.mapError((cause) => new TestLoginStoreError({ cause })),
    );

  /** Applies one change under the write lock, so concurrent saves never drop each other. */
  const change = <A, E>(
    apply: (
      logins: ReadonlyArray<StoredTestLogin>,
    ) => Effect.Effect<readonly [A, ReadonlyArray<StoredTestLogin>], E>,
  ) =>
    writes.withPermit(
      Effect.gen(function* () {
        const [result, next] = yield* apply(yield* read);
        yield* write(next);
        return result;
      }),
    );

  const findOrFail = (logins: ReadonlyArray<StoredTestLogin>, id: string) => {
    const login = logins.find((candidate) => candidate.id === id);
    return login ? Effect.succeed(login) : Effect.fail(new TestLoginNotFoundError({ id }));
  };

  const save: TestLoginStore["Service"]["save"] = (input, createdBy) =>
    change((logins) =>
      Effect.gen(function* () {
        const id = yield* crypto
          .randomUUIDv4()
          .pipe(Effect.mapError((cause) => new TestLoginStoreError({ cause })));
        const now = DateTime.formatIso(DateTime.makeUnsafe(yield* Clock.currentTimeMillis));
        const login: StoredTestLogin = {
          id,
          label: input.label?.trim() ?? "",
          url: input.url.trim(),
          username: input.username,
          password: input.password,
          otpSecret: input.otpSecret?.trim() || null,
          createdAt: now,
          createdBy,
        };
        return [summarizeTestLogin(login), [...logins, login]] as const;
      }),
    ).pipe(Effect.withSpan("TestLoginStore.save"));

  const update: TestLoginStore["Service"]["update"] = (input) =>
    change((logins) =>
      Effect.gen(function* () {
        const current = yield* findOrFail(logins, input.id);
        const next: StoredTestLogin = {
          ...current,
          ...(input.url === undefined ? {} : { url: input.url.trim() }),
          ...(input.username === undefined ? {} : { username: input.username }),
          ...(input.password === undefined ? {} : { password: input.password }),
          ...(input.label === undefined ? {} : { label: input.label.trim() }),
          ...(input.otpSecret === undefined ? {} : { otpSecret: input.otpSecret?.trim() || null }),
        };
        return [
          summarizeTestLogin(next),
          logins.map((login) => (login.id === input.id ? next : login)),
        ] as const;
      }),
    ).pipe(Effect.withSpan("TestLoginStore.update"));

  const remove: TestLoginStore["Service"]["remove"] = (id) =>
    change((logins) =>
      findOrFail(logins, id).pipe(
        Effect.as([undefined, logins.filter((login) => login.id !== id)] as const),
      ),
    ).pipe(Effect.withSpan("TestLoginStore.remove"));

  const reveal: TestLoginStore["Service"]["reveal"] = (id) =>
    read.pipe(
      Effect.flatMap((logins) => findOrFail(logins, id)),
      Effect.map((login) => ({ password: login.password, otpSecret: login.otpSecret })),
      Effect.withSpan("TestLoginStore.reveal"),
    );

  return TestLoginStore.of({
    list: read.pipe(Effect.withSpan("TestLoginStore.list")),
    save,
    update,
    remove,
    reveal,
  });
});

export const layer = Layer.effect(TestLoginStore, make);
