import { describe, expect, it } from "vite-plus/test";

import type { OrbitGatewaySettings } from "./client.ts";
import {
  attachedServersNeedSettings,
  nextStoredAttachedServers,
  readAttachedThreadsSection,
} from "./attachedThreads.ts";

const settings = (
  attachedThreads: unknown,
  sectionVersion: number | null,
  version = 9,
): OrbitGatewaySettings => ({
  profileId: 2,
  version,
  workspaces: [],
  updatedAt: "2026-11-14T12:00:00Z",
  document:
    attachedThreads === undefined ? { workspaces: [] } : { workspaces: [], attachedThreads },
  sections:
    sectionVersion === null
      ? {}
      : { attachedThreads: { version: sectionVersion, updatedAt: null, updatedBy: null } },
});

const environments = [
  { environmentId: "outer-mini", instanceId: null },
  { environmentId: "inner-a", instanceId: 41 },
  { environmentId: "inner-b", instanceId: 42 },
];

describe("readAttachedThreadsSection", () => {
  it("lists the environments of the attached threads with the section version", () => {
    expect(
      readAttachedThreadsSection(
        settings(
          {
            schema: 1,
            threads: [
              { environmentId: "inner-a", threadId: "t1" },
              { environmentId: "inner-a", threadId: "t2" },
              { environmentId: 5, threadId: "bad" },
              { environmentId: "inner-c" },
            ],
          },
          4,
        ),
      ),
    ).toEqual({ version: 4, environmentIds: ["inner-a"] });
  });

  it("reads a missing or null section as an empty set at version 0", () => {
    expect(readAttachedThreadsSection(settings(undefined, null))).toEqual({
      version: 0,
      environmentIds: [],
    });
    expect(readAttachedThreadsSection(settings(null, null))).toEqual({
      version: 0,
      environmentIds: [],
    });
  });
});

describe("nextStoredAttachedServers", () => {
  it("keeps the attached set and the container servers (never the host servers)", () => {
    expect(
      nextStoredAttachedServers({
        previous: null,
        profileId: 2,
        profileVersion: 9,
        settings: settings(
          { schema: 1, threads: [{ environmentId: "inner-a", threadId: "t" }] },
          3,
        ),
        environments,
      }),
    ).toEqual({
      schema: 1,
      profileId: 2,
      profileVersion: 9,
      version: 3,
      attached: ["inner-a"],
      containers: ["inner-a", "inner-b"],
    });
  });

  it("without a settings read keeps the attached part and refreshes the containers", () => {
    const previous = nextStoredAttachedServers({
      previous: null,
      profileId: 2,
      profileVersion: 9,
      settings: settings({ schema: 1, threads: [{ environmentId: "inner-a", threadId: "t" }] }, 3),
      environments: environments.slice(0, 2),
    });
    expect(
      nextStoredAttachedServers({
        previous,
        profileId: 2,
        profileVersion: 9,
        settings: null,
        environments,
      }),
    ).toEqual({ ...previous, containers: ["inner-a", "inner-b"] });
    // Another profile, not read yet: nothing is held off until its settings are read.
    expect(
      nextStoredAttachedServers({
        previous,
        profileId: 1,
        profileVersion: 50,
        settings: null,
        environments,
      }),
    ).toMatchObject({ profileId: 1, profileVersion: -1, version: 0, attached: [] });
  });

  it("asks for settings only when the profile or its version changed", () => {
    const previous = nextStoredAttachedServers({
      previous: null,
      profileId: 2,
      profileVersion: 9,
      settings: settings(undefined, null),
      environments,
    });
    expect(attachedServersNeedSettings(null, 2, 9)).toBe(true);
    expect(attachedServersNeedSettings(previous, 2, 9)).toBe(false);
    expect(attachedServersNeedSettings(previous, 2, 10)).toBe(true);
    expect(attachedServersNeedSettings(previous, 1, 9)).toBe(true);
  });
});
