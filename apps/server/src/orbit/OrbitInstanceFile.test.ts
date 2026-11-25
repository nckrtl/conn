import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as NodeURL from "node:url";

import { parseOrbitInstanceFile, readOrbitInstanceDescriptor } from "./OrbitInstanceFile.ts";

const fixturePath = NodeURL.fileURLToPath(new URL("./fixtures/orbit-instance", import.meta.url));

it.effect("reads every fact from Orbit's instance file", () =>
  Effect.gen(function* () {
    expect(yield* readOrbitInstanceDescriptor(fixturePath)).toEqual({
      projectId: 7,
      instanceId: 41,
      projectSlug: "hauzer",
      projectName: "Hauzer App",
      instanceName: "t3-1a2b3c4d",
      nodeName: "beast",
      url: "https://t3-1a2b3c4d.hauzer.test",
    });
    expect(yield* readOrbitInstanceDescriptor(`${fixturePath}.missing`)).toBeUndefined();
  }).pipe(Effect.provide(NodeServices.layer)),
);

it.each([
  {
    name: "an old clone without the new keys has no descriptor",
    text: "# Managed by Orbit.\nORBIT_INSTANCE_ID=41\nORBIT_INSTANCE=t3-1\nORBIT_PROJECT=hauzer\nORBIT_URL=\n",
    expected: undefined,
  },
  {
    name: "a missing instance id drops the descriptor",
    text: "ORBIT_PROJECT_ID=7\nORBIT_PROJECT=hauzer\n",
    expected: undefined,
  },
  {
    name: "ids must be positive integers",
    text: "ORBIT_PROJECT_ID=7\nORBIT_INSTANCE_ID=0\n",
    expected: undefined,
  },
  {
    name: "non-numeric ids are refused",
    text: "ORBIT_PROJECT_ID=7x\nORBIT_INSTANCE_ID=41\n",
    expected: undefined,
  },
  {
    name: "empty and missing facts are absent; comments, junk and unknown keys are ignored",
    text: "# ORBIT_NODE=commented\n\nnot a pair\n=7\nORBIT_PROJECT_ID=7\r\nORBIT_INSTANCE_ID=41\nORBIT_PROJECT_NAME=\nORBIT_URL=\nORBIT_FUTURE=1\n",
    expected: { projectId: 7, instanceId: 41 },
  },
  {
    name: "a value keeps spaces and later '=' signs",
    text: "ORBIT_PROJECT_ID=7\nORBIT_INSTANCE_ID=41\nORBIT_PROJECT_NAME=  Hauzer = App  \n",
    expected: { projectId: 7, instanceId: 41, projectName: "Hauzer = App" },
  },
  {
    name: "a non-web URL is dropped",
    text: "ORBIT_PROJECT_ID=7\nORBIT_INSTANCE_ID=41\nORBIT_URL=javascript:alert(1)\n",
    expected: { projectId: 7, instanceId: 41 },
  },
])("$name", ({ text, expected }) => {
  expect(parseOrbitInstanceFile(text)).toEqual(expected);
});
