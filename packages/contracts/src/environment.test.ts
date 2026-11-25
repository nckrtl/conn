import * as Schema from "effect/Schema";
import { describe, expect, it } from "vite-plus/test";

import { ExecutionEnvironmentDescriptor } from "./environment.ts";

const decodeDescriptor = Schema.decodeUnknownSync(ExecutionEnvironmentDescriptor);

const descriptor = {
  environmentId: "environment-1",
  label: "Local",
  platform: { os: "darwin", arch: "arm64" },
  serverVersion: "0.0.32",
  capabilities: { repositoryIdentity: true },
} as const;

describe("ExecutionEnvironmentDescriptor", () => {
  it("decodes old, recognized and future manual installation descriptors", () => {
    expect(decodeDescriptor(descriptor).capabilities.serverInstallation).toBeUndefined();
    for (const installation of [
      { kind: "npx" },
      { kind: "npm-global", prefix: "/opt/node" },
      { kind: "t3-launcher", launcher: "/opt/bin/t3", baseDir: "/data/t3" },
    ]) {
      expect(
        decodeDescriptor({
          ...descriptor,
          capabilities: { ...descriptor.capabilities, serverInstallation: installation },
        }).capabilities.serverInstallation,
      ).toEqual(installation);
    }
    const spaced = { kind: "t3-launcher", launcher: "/opt/bin/t3 ", baseDir: " /data/t3 " };
    expect(
      decodeDescriptor({
        ...descriptor,
        capabilities: { ...descriptor.capabilities, serverInstallation: spaced },
      }).capabilities.serverInstallation,
    ).toEqual(spaced);
    for (const installation of [
      { kind: "future-manager" },
      { kind: "npm-global" },
      { kind: "t3-launcher", launcher: "t3" },
    ]) {
      expect(
        decodeDescriptor({
          ...descriptor,
          capabilities: { ...descriptor.capabilities, serverInstallation: installation },
        }).capabilities.serverInstallation,
      ).toBeUndefined();
    }
  });

  it("decodes an Orbit Instance descriptor with or without its facts", () => {
    const facts = {
      projectId: 7,
      instanceId: 41,
      projectSlug: "hauzer",
      projectName: "Hauzer App",
      instanceName: "t3-1a2b3c4d",
      nodeName: "beast",
      url: "https://t3-1a2b3c4d.hauzer.test",
    };
    expect(decodeDescriptor({ ...descriptor, orbitInstance: facts }).orbitInstance).toEqual(facts);
    expect(
      decodeDescriptor({ ...descriptor, orbitInstance: { projectId: 7, instanceId: 41 } })
        .orbitInstance,
    ).toEqual({ projectId: 7, instanceId: 41 });
    expect(decodeDescriptor(descriptor).orbitInstance).toBeUndefined();
  });
});
