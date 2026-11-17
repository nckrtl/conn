import { describe, expect, it } from "vite-plus/test";

import { createOrbitGatewayClient } from "./client.ts";
import {
  filterOrbitInstances,
  groupOrbitInstances,
  joinOrbitInstanceThreads,
  listOrbitInstances,
  orbitInstanceAvailability,
  orbitInstanceProjectOptions,
  type OrbitInstanceListRow,
} from "./instanceList.ts";

const clone = (fields: Record<string, unknown>) => ({
  url: "http://10.44.0.20:3773",
  status: "registered",
  power_state: "running",
  node_name: "beast",
  ...fields,
});

/** The Gateway's `/environments` and `/projects` bodies, as Orbit sends them today. */
const bodies: Record<string, unknown> = {
  "/environments": [
    {
      environment_id: "host-mini",
      label: "mini",
      url: "http://10.44.0.3:3773",
      status: "registered",
    },
    clone({
      environment_id: "env-default",
      label: "nckrtl default",
      instance_id: 1,
      project_id: 5,
      instance_name: "default",
      instance_url: "https://nckrtl.test",
    }),
    clone({
      environment_id: "env-pricing",
      label: "pricing-page",
      instance_id: 11,
      project_id: 5,
      project_slug: "nckrtl",
      instance_name: "pricing-page",
      instance_url: "https://pricing-page.nckrtl.test",
    }),
    clone({
      environment_id: "env-spike-old",
      label: "old-spike",
      instance_id: 12,
      project_id: 5,
      instance_name: "old-spike",
      status: "session_expired",
    }),
    clone({
      environment_id: "env-spike",
      label: "old-spike",
      instance_id: 12,
      project_id: 5,
      instance_name: "old-spike",
      power_state: "stopped",
      instance_url: "https://old-spike.nckrtl.test",
    }),
    // A Project the Projects list leaves out: named from the record itself.
    clone({
      environment_id: "env-bench",
      label: "bench-a",
      instance_id: 21,
      project_id: 66,
      project_name: "create-bench",
      project_slug: "create-bench",
      instance_name: "bench-a",
      node_name: "nick",
    }),
    // Few fields: no name, URL, Node or power state.
    {
      environment_id: "env-bare",
      label: "bare",
      url: "http://x",
      status: "registered",
      instance_id: 31,
      project_id: 3,
    },
  ],
  "/projects": [
    { id: 3, slug: "mealou", name: "Mealou", node_id: 7, node_name: "shark" },
    { id: 4, slug: "hauzer", name: "Hauzer", node_id: 7, node_name: "beast" },
    { id: 5, slug: "nckrtl", name: "nckrtl.com", node_id: 7, node_name: "beast" },
  ],
};

const gateway = createOrbitGatewayClient(async (request) => ({
  status: 200,
  body: JSON.stringify({ data: bodies[request.path.split("?")[0]!] }),
}));

function row(fields: Partial<OrbitInstanceListRow> & Pick<OrbitInstanceListRow, "id" | "name">) {
  return {
    projectId: 5,
    projectSlug: "nckrtl",
    projectName: "nckrtl.com",
    nodeName: "beast",
    domain: `${fields.name}.nckrtl.test`,
    instanceUrl: `https://${fields.name}.nckrtl.test`,
    powerState: "running",
    status: "registered",
    environmentId: `env-${fields.name}`,
    branch: null,
    ...fields,
  } satisfies OrbitInstanceListRow;
}

describe("listOrbitInstances", () => {
  it("lists each Instance once, without defaults or host servers, named from the Projects", async () => {
    const rows = await listOrbitInstances(gateway);
    expect(
      rows.map(
        ({ id, name, projectName, nodeName, domain, powerState, status, environmentId }) => ({
          id,
          name,
          projectName,
          nodeName,
          domain,
          powerState,
          status,
          environmentId,
        }),
      ),
    ).toEqual([
      {
        id: 11,
        name: "pricing-page",
        projectName: "nckrtl.com",
        nodeName: "beast",
        domain: "pricing-page.nckrtl.test",
        powerState: "running",
        status: "registered",
        environmentId: "env-pricing",
      },
      {
        id: 12,
        name: "old-spike",
        projectName: "nckrtl.com",
        nodeName: "beast",
        domain: "old-spike.nckrtl.test",
        powerState: "stopped",
        status: "registered",
        environmentId: "env-spike",
      },
      {
        id: 21,
        name: "bench-a",
        projectName: "create-bench",
        nodeName: "nick",
        domain: null,
        powerState: "running",
        status: "registered",
        environmentId: "env-bench",
      },
      {
        id: 31,
        name: "bare",
        projectName: "Mealou",
        nodeName: "shark",
        domain: null,
        powerState: null,
        status: "registered",
        environmentId: "env-bare",
      },
    ]);
    expect(rows.every((entry) => entry.branch === null && entry.git === undefined)).toBe(true);
  });

  it("groups by Project, offers only Projects with Instances, and searches", async () => {
    const rows = await listOrbitInstances(gateway);
    expect(
      groupOrbitInstances(rows).map((group) => [group.projectName, group.rows.length]),
    ).toEqual([
      ["create-bench", 1],
      ["Mealou", 1],
      ["nckrtl.com", 2],
    ]);
    // Hauzer has no Instance, so the filter leaves it out.
    expect(
      orbitInstanceProjectOptions(rows).map((option) => [option.projectName, option.count]),
    ).toEqual([
      ["create-bench", 1],
      ["Mealou", 1],
      ["nckrtl.com", 2],
    ]);
    const names = (query: string, projectId: number | null = null) =>
      filterOrbitInstances(rows, { query, projectId }).map((entry) => entry.name);
    expect(names("PRICING")).toEqual(["pricing-page"]);
    expect(names("nckrtl.com")).toEqual(["pricing-page", "old-spike"]);
    expect(names("shark")).toEqual(["bare"]);
    expect(names("old-spike.nckrtl")).toEqual(["old-spike"]);
    expect(names("", 66)).toEqual(["bench-a"]);
    expect(names("pricing", 66)).toEqual([]);
  });
});

describe("orbitInstanceAvailability", () => {
  it("names why a thread cannot start, including a row with no agent server", () => {
    expect(orbitInstanceAvailability(row({ id: 1, name: "a" }))).toEqual({
      state: "running",
      label: null,
      blockedReason: null,
    });
    // Conn wakes an asleep Instance when a thread starts in it; the row keeps its state word.
    expect(orbitInstanceAvailability(row({ id: 2, name: "b", powerState: "stopped" }))).toEqual({
      state: "stopped",
      label: "Stopped",
      blockedReason: null,
    });
    // An older Gateway without the wake route: today's blocking reason.
    expect(
      orbitInstanceAvailability(row({ id: 2, name: "b", powerState: "stopped" }), false),
    ).toEqual({
      state: "stopped",
      label: "Stopped",
      blockedReason: "Orbit cannot start a stopped Instance yet",
    });
    expect(
      orbitInstanceAvailability(row({ id: 3, name: "c", status: "session_expired" })).state,
    ).toBe("expired");
    // Possible only once Orbit's flat list is the source.
    expect(orbitInstanceAvailability(row({ id: 4, name: "d", environmentId: null }))).toEqual({
      state: "no-server",
      label: "No agent server",
      blockedReason: "No agent server",
    });
  });
});

describe("joinOrbitInstanceThreads", () => {
  it("counts live threads per environment, newest first, with working ones and last use", () => {
    const thread = (id: string, environmentId: string, updatedAt: string, extra = {}) => ({
      id,
      environmentId,
      title: `Thread ${id}`,
      updatedAt,
      archivedAt: null,
      working: false,
      ...extra,
    });
    const joined = joinOrbitInstanceThreads(
      [
        row({ id: 1, name: "quiet" }),
        row({ id: 2, name: "busy" }),
        row({ id: 3, name: "asleep", powerState: "stopped" }),
        row({ id: 4, name: "serverless", environmentId: null }),
      ],
      [
        thread("t1", "env-busy", "2026-11-12T09:00:00Z"),
        thread("t2", "env-busy", "2026-11-12T10:00:00Z", { working: true }),
        thread("t3", "env-busy", "2026-11-12T11:00:00Z", { archivedAt: "2026-11-12T11:00:00Z" }),
        thread("t4", "env-asleep", "2026-11-12T12:00:00Z"),
        thread("t5", "env-elsewhere", "2026-11-12T12:00:00Z"),
      ],
    );
    expect(
      joined.map(({ name, threads, workingCount, lastUsedAt }) => ({
        name,
        threads: threads.map((entry) => entry.id),
        workingCount,
        lastUsedAt,
      })),
    ).toEqual([
      { name: "busy", threads: ["t2", "t1"], workingCount: 1, lastUsedAt: "2026-11-12T10:00:00Z" },
      { name: "quiet", threads: [], workingCount: 0, lastUsedAt: null },
      { name: "asleep", threads: ["t4"], workingCount: 0, lastUsedAt: "2026-11-12T12:00:00Z" },
      { name: "serverless", threads: [], workingCount: 0, lastUsedAt: null },
    ]);
  });
});
