import { EnvironmentId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  joinMachineAndDetail,
  projectMachineLabel,
  projectMachineNames,
  summarizeMachineNames,
} from "./projectMachineLabel";

const mac = EnvironmentId.make("mac");
const server = EnvironmentId.make("server");
const nas = EnvironmentId.make("nas");
const labels: Record<string, string> = { mac: "Mac mini", server: "Hetzner", nas: "NAS" };
const labelFor = (environmentId: EnvironmentId) => labels[environmentId] ?? null;

describe("projectMachineNames", () => {
  it("lists each machine once, in first-seen order", () => {
    expect(
      projectMachineNames(
        [{ environmentId: server }, { environmentId: mac }, { environmentId: server }],
        labelFor,
      ),
    ).toEqual(["Hetzner", "Mac mini"]);
  });

  it("skips environments without a name", () => {
    expect(
      projectMachineNames(
        [{ environmentId: EnvironmentId.make("unknown") }, { environmentId: mac }],
        labelFor,
      ),
    ).toEqual(["Mac mini"]);
  });
});

describe("summarizeMachineNames", () => {
  it("returns null for no machines, the names for one or two, and a count beyond that", () => {
    expect(summarizeMachineNames([])).toBeNull();
    expect(summarizeMachineNames(["Mac mini"])).toBe("Mac mini");
    expect(summarizeMachineNames(["Mac mini", "Hetzner"])).toBe("Mac mini, Hetzner");
    expect(summarizeMachineNames(["Mac mini", "Hetzner", "NAS"])).toBe("3 machines");
  });
});

describe("projectMachineLabel", () => {
  it("is null when the lookup hides every machine (single-machine setups)", () => {
    expect(projectMachineLabel([{ environmentId: mac }], () => null)).toBeNull();
  });

  it("counts distinct machines, not projects", () => {
    expect(
      projectMachineLabel(
        [{ environmentId: mac }, { environmentId: mac }, { environmentId: nas }],
        labelFor,
      ),
    ).toBe("Mac mini, NAS");
  });
});

describe("joinMachineAndDetail", () => {
  it("prefixes the machine when there is one", () => {
    expect(joinMachineAndDetail("Mac mini", "/Users/me/apps")).toBe("Mac mini · /Users/me/apps");
    expect(joinMachineAndDetail(null, "/Users/me/apps")).toBe("/Users/me/apps");
  });
});
