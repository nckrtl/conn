import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import * as ServerConfig from "../config.ts";
import * as TestLoginStore from "./TestLoginStore.ts";

it.effect("persists saved test logins and reads them from a fresh store", () => {
  const layer = TestLoginStore.layer.pipe(
    Layer.provideMerge(ServerSecretStore.layer),
    Layer.provide(ServerConfig.layerTest(process.cwd(), { prefix: "t3-test-login-store-" })),
    Layer.provide(NodeServices.layer),
  );
  return Effect.gen(function* () {
    const store = yield* TestLoginStore.TestLoginStore;
    const input = {
      url: "http://localhost:3000/login",
      label: "fixture",
      username: "fixture@example.test",
      password: "fixture-password",
      otpSecret: "GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ",
    };
    const saved = yield* store.save(input, "agent");
    expect(saved.id).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );
    expect(saved).toMatchObject({ username: input.username, createdBy: "agent", hasOtp: true });
    expect(saved).not.toHaveProperty("password");
    expect(saved).not.toHaveProperty("otpSecret");
    const persisted = yield* Effect.gen(function* () {
      const fresh = yield* TestLoginStore.TestLoginStore;
      return { list: yield* fresh.list, secrets: yield* fresh.reveal(saved.id) };
    }).pipe(Effect.provide(TestLoginStore.layer.pipe(Layer.provide(NodeServices.layer))));
    expect(persisted.list).toEqual([
      { ...input, id: saved.id, createdAt: saved.createdAt, createdBy: "agent" },
    ]);
    expect(persisted.secrets).toEqual({ password: input.password, otpSecret: input.otpSecret });
  }).pipe(Effect.provide(layer), Effect.scoped);
});
