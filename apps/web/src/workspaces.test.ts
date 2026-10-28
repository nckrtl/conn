import { beforeEach, describe, expect, it } from "vite-plus/test";

import { useWorkspaceStore } from "./workspaceStore";
import {
  groupProjectsByConnection,
  reorderWorkspaces,
  workspaceShortcutIndex,
  isWorkspaceImage,
  WORKSPACE_IMAGE_MAX_CHARS,
  findWorkspace,
  nextWorkspaceColor,
  resolveScopedProjectKeys,
  validateWorkspaceDraft,
  workspaceLetter,
  workspaceNameKey,
  workspaceProjectRefs,
  type Workspace,
} from "./workspaces.logic";

const group = (projectKey: string, ...refs: [string, string][]) => ({
  projectKey,
  memberProjectRefs: refs.map(([environmentId, projectId]) => ({ environmentId, projectId })),
});
const orbit = group("repo:orbit", ["local", "p1"], ["beast", "p9"]);
const drift = group("repo:drift", ["local", "p2"]);
const rooms = group("repo:rooms", ["local", "p3"]);
const workspace = (name: string, projectKeys: string[], id = `ws-${name}`): Workspace => ({
  id,
  name,
  projectKeys,
  color: "blue",
  icon: null,
});

describe("workspaces.logic", () => {
  it("shows a workspace's first letter or digit", () => {
    expect(workspaceLetter("orbit")).toBe("O");
    expect(workspaceLetter("  (3d) apps")).toBe("3");
    expect(workspaceLetter("émigré")).toBe("É");
    expect(workspaceLetter("—")).toBe("?");
  });

  it("finds workspaces by id or by name the way Rooms compares names", () => {
    const all = [workspace("Orbit", []), workspace("Desktop apps", [])];
    expect(findWorkspace(all, "ws-Orbit")?.name).toBe("Orbit");
    expect(findWorkspace(all, "orbit")?.name).toBe("Orbit");
    expect(findWorkspace(all, "desktop-apps")?.name).toBe("Desktop apps");
    expect(findWorkspace(all, "missing")).toBeNull();
    expect(findWorkspace([...all, workspace("ORBIT", [], "ws-2")], "orbit")).toBeNull();
    expect(workspaceNameKey("Désktop Apps!")).toBe("desktopapps");
    expect(findWorkspace([workspace("DLF - Leden", []), workspace("Orbit", [])], "DLF")?.name).toBe(
      "DLF - Leden",
    );
    expect(findWorkspace([workspace("DLF", []), workspace("DLF - Leden", [])], "DLF")?.name).toBe(
      "DLF",
    );
    expect(
      findWorkspace([workspace("DLF - Leden", []), workspace("DLF Members", [])], "DLF"),
    ).toBeNull();
  });

  it("scopes the sidebar to the workspace's projects, across environments", () => {
    const groups = [orbit, drift, rooms];
    expect(
      resolveScopedProjectKeys({
        projectGroups: groups,
        workspace: null,
        scopedProjectGroups: [],
      }),
    ).toBeNull();
    expect(
      resolveScopedProjectKeys({
        projectGroups: groups,
        workspace: workspace("Desktop", ["repo:drift", "repo:rooms", "repo:gone"]),
        scopedProjectGroups: [],
      }),
    ).toEqual(new Set(["local:p2", "local:p3"]));
    expect(
      resolveScopedProjectKeys({
        projectGroups: groups,
        workspace: null,
        scopedProjectGroups: [orbit],
      }),
    ).toEqual(new Set(["local:p1", "beast:p9"]));
  });

  it("narrows a workspace further by the sidebar's project filter, never widens it", () => {
    const desktop = workspace("Desktop", ["repo:drift", "repo:rooms"]);
    expect(
      resolveScopedProjectKeys({
        projectGroups: [orbit, drift, rooms],
        workspace: desktop,
        scopedProjectGroups: [drift],
      }),
    ).toEqual(new Set(["local:p2"]));
    expect(
      resolveScopedProjectKeys({
        projectGroups: [orbit, drift, rooms],
        workspace: desktop,
        scopedProjectGroups: [orbit],
      }),
    ).toEqual(new Set());
    expect(
      resolveScopedProjectKeys({
        projectGroups: [orbit],
        workspace: workspace("Empty", []),
        scopedProjectGroups: [],
      }),
    ).toEqual(new Set());
  });

  it("keeps matching projects on different machines independent", () => {
    const localOnly = { ...workspace("Orbit", []), projectRefs: ["local:p1"] };
    expect(
      resolveScopedProjectKeys({
        projectGroups: [orbit, drift],
        workspace: localOnly,
        scopedProjectGroups: [],
      }),
    ).toEqual(new Set(["local:p1"]));
    expect(
      resolveScopedProjectKeys({
        projectGroups: [orbit],
        workspace: { ...localOnly, projectRefs: ["beast:p9"] },
        scopedProjectGroups: [orbit],
      }),
    ).toEqual(new Set(["beast:p9"]));
    expect(
      resolveScopedProjectKeys({
        projectGroups: [orbit],
        workspace: { ...localOnly, projectRefs: [] },
        scopedProjectGroups: [],
      }),
    ).toEqual(new Set());
    const catalog = [
      { projectKey: "repo:orbit", displayName: "orbit", refs: ["local:p1", "beast:p9"] },
    ];
    expect(workspaceProjectRefs(localOnly, catalog)).toEqual(new Set(["local:p1"]));
    expect(workspaceProjectRefs({ ...localOnly, projectRefs: ["beast:p9"] }, [])).toEqual(
      new Set(["beast:p9"]),
    );
  });

  it("validates drafts", () => {
    expect(
      validateWorkspaceDraft({
        name: "  Desktop   apps ",
        projectKeys: ["a", "a", "b"],
        color: "teal",
        icon: null,
      }),
    ).toEqual({
      name: "Desktop apps",
      projectKeys: ["a", "b"],
      color: "teal",
      icon: null,
      image: null,
    });
    expect(() =>
      validateWorkspaceDraft({ name: " ", projectKeys: [], color: "teal", icon: null }),
    ).toThrow("name");
    expect(() =>
      validateWorkspaceDraft({ name: "All", projectKeys: [], color: "teal", icon: null }),
    ).toThrow("reserved");
    expect(() =>
      validateWorkspaceDraft({ name: "x", projectKeys: [], color: "purple", icon: null }),
    ).toThrow("color");
  });

  it("gives new workspaces an unused color first", () => {
    expect(nextWorkspaceColor([])).toBe("slate");
    expect(nextWorkspaceColor([{ ...workspace("a", []), color: "slate" }])).toBe("red");
  });
});

describe("workspaceProjectRefs", () => {
  it("lists the refs new threads may use in a workspace", () => {
    const projects = [
      { projectKey: "repo:orbit", displayName: "orbit", refs: ["local:p1", "beast:p9"] },
      { projectKey: "repo:drift", displayName: "drift", refs: ["local:p2"] },
    ];
    expect(workspaceProjectRefs(null, projects)).toBeNull();
    expect(workspaceProjectRefs(workspace("Orbit", ["repo:orbit"]), projects)).toEqual(
      new Set(["local:p1", "beast:p9"]),
    );
    expect(workspaceProjectRefs(workspace("Empty", []), projects)).toEqual(new Set());
  });
});

describe("workspaceStore", () => {
  beforeEach(() =>
    useWorkspaceStore.setState({ workspaces: [], activeWorkspaceId: null, availableProjects: [] }),
  );

  it("creates, selects by name, renames and deletes workspaces", () => {
    const store = useWorkspaceStore.getState();
    const created = store.createWorkspace({
      name: "Orbit",
      projectKeys: ["repo:orbit"],
      color: "blue",
      icon: null,
    });
    expect(useWorkspaceStore.getState().selectWorkspaceByName("orbit")).toEqual({
      found: true,
      workspace: created,
    });
    expect(useWorkspaceStore.getState().activeWorkspaceId).toBe(created.id);

    expect(() =>
      store.createWorkspace({ name: "ORBIT", projectKeys: [], color: "red", icon: null }),
    ).toThrow("already exists");
    useWorkspaceStore.getState().updateWorkspace(created.id, {
      name: "Orbit HQ",
      projectKeys: [],
      color: "red",
      icon: "rocket",
    });
    expect(useWorkspaceStore.getState().workspaces[0]).toMatchObject({
      name: "Orbit HQ",
      color: "red",
      icon: "rocket",
    });

    expect(useWorkspaceStore.getState().selectWorkspaceByName("nope")).toEqual({
      found: false,
      workspace: null,
    });
    expect(useWorkspaceStore.getState().activeWorkspaceId).toBe(created.id);
    expect(useWorkspaceStore.getState().selectWorkspaceByName("all")).toEqual({
      found: true,
      workspace: null,
    });
    expect(useWorkspaceStore.getState().activeWorkspaceId).toBeNull();

    useWorkspaceStore.getState().selectWorkspace(created.id);
    useWorkspaceStore.getState().deleteWorkspace(created.id);
    expect(useWorkspaceStore.getState()).toMatchObject({ workspaces: [], activeWorkspaceId: null });
  });

  it("saves separate machine selections and preserves them on rehydration", async () => {
    const store = useWorkspaceStore.getState();
    const created = store.createWorkspace({
      name: "Orbit",
      projectKeys: [],
      projectRefs: ["local:p1", "beast:p9"],
      color: "blue",
      icon: null,
    });
    store.updateWorkspace(created.id, { ...created, projectRefs: ["beast:p9"] });
    await useWorkspaceStore.persist.rehydrate();
    const saved = useWorkspaceStore.getState().workspaces.find((w) => w.id === created.id)!;
    expect(
      workspaceProjectRefs(saved, [
        { projectKey: "repo:orbit", displayName: "orbit", refs: ["local:p1", "beast:p9"] },
      ]),
    ).toEqual(new Set(["beast:p9"]));
    expect(saved.projectKeys).toEqual([]);
  });

  it("ignores selecting an unknown workspace id", () => {
    useWorkspaceStore.getState().selectWorkspace("ws-unknown");
    expect(useWorkspaceStore.getState().activeWorkspaceId).toBeNull();
  });

  it("publishes the sidebar's projects only when they change", () => {
    const projects = [{ projectKey: "repo:orbit", displayName: "orbit", refs: ["local:p1"] }];
    useWorkspaceStore.getState().publishProjects(projects);
    const first = useWorkspaceStore.getState().availableProjects;
    useWorkspaceStore
      .getState()
      .publishProjects([{ projectKey: "repo:orbit", displayName: "orbit", refs: ["local:p1"] }]);
    expect(useWorkspaceStore.getState().availableProjects).toBe(first);
  });
});

describe("groupProjectsByConnection", () => {
  const here = {
    environmentId: "env-here",
    label: "mini",
    kind: "desktop",
    primary: true,
  } as const;
  const beast = {
    environmentId: "env-beast",
    label: "beast",
    kind: "server",
    primary: false,
  } as const;
  const alpha = {
    environmentId: "env-alpha",
    label: "alpha",
    kind: "server",
    primary: false,
  } as const;
  const project = (
    projectKey: string,
    connections: readonly (typeof here | typeof beast | typeof alpha)[],
  ) => ({
    projectKey,
    displayName: projectKey,
    refs: [],
    connections,
  });

  it("lists this machine first, then other connections by name, then unknown projects", () => {
    const sections = groupProjectsByConnection([
      project("rooms", [beast]),
      project("drift", [here, beast]),
      project("t3code", [here]),
      project("orbit", [alpha]),
      { projectKey: "gone", displayName: "gone", refs: [] },
    ]);
    expect(
      sections.map((section) => [
        section.connection?.label ?? null,
        section.projects.map((p) => p.projectKey),
      ]),
    ).toEqual([
      ["mini", ["drift", "t3code"]],
      ["alpha", ["orbit"]],
      ["beast", ["rooms", "drift"]],
      [null, ["gone"]],
    ]);
  });
});

describe("workspace images", () => {
  const png =
    "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";
  const draft = { name: "Orbit", projectKeys: [], color: "violet", icon: null };

  it("accepts small PNG, JPEG and WebP data URLs only", () => {
    expect(isWorkspaceImage(png)).toBe(true);
    expect(isWorkspaceImage(png.replace("image/png", "image/webp"))).toBe(true);
    expect(isWorkspaceImage("data:image/svg+xml;base64,PHN2Zz4=")).toBe(false);
    expect(isWorkspaceImage("https://example.com/icon.png")).toBe(false);
    expect(isWorkspaceImage(`data:image/png;base64,${"A".repeat(WORKSPACE_IMAGE_MAX_CHARS)}`)).toBe(
      false,
    );
  });

  it("keeps a valid image, defaults to none and rejects others", () => {
    expect(validateWorkspaceDraft({ ...draft, image: png }).image).toBe(png);
    expect(validateWorkspaceDraft(draft).image).toBeNull();
    expect(() => validateWorkspaceDraft({ ...draft, image: "javascript:alert(1)" })).toThrow(
      "That image can't be used.",
    );
  });
});

describe("workspace order and shortcuts", () => {
  it("uses both physical number rows with exactly Command and Option", () => {
    const event = {
      code: "Digit1",
      key: "¡",
      metaKey: true,
      shiftKey: false,
      altKey: true,
      ctrlKey: false,
    };
    for (let digit = 1; digit <= 9; digit++) {
      expect(workspaceShortcutIndex({ ...event, code: `Digit${digit}` })).toBe(digit - 1);
      expect(workspaceShortcutIndex({ ...event, code: `Numpad${digit}`, key: String(digit) })).toBe(
        digit - 1,
      );
    }
    expect(workspaceShortcutIndex({ ...event, metaKey: false })).toBeNull();
    expect(workspaceShortcutIndex({ ...event, shiftKey: true })).toBeNull();
    expect(workspaceShortcutIndex({ ...event, ctrlKey: true })).toBeNull();
    expect(workspaceShortcutIndex({ ...event, altKey: false })).toBeNull();
    expect(
      workspaceShortcutIndex({ ...event, altKey: false, shiftKey: true, code: "Digit3" }),
    ).toBeNull();
    expect(workspaceShortcutIndex({ ...event, code: "Digit0", key: "0" })).toBeNull();
    expect(workspaceShortcutIndex({ ...event, code: "Numpad0", key: "0" })).toBeNull();
    expect(workspaceShortcutIndex({ ...event, code: "KeyA", key: "1" })).toBeNull();
    expect(workspaceShortcutIndex({ ...event, code: "", key: "3" })).toBe(2);
  });

  it("moves a workspace both ways and ignores missing or unchanged targets", () => {
    const all = [workspace("A", []), workspace("B", []), workspace("C", [])];
    const next = reorderWorkspaces(all, "ws-C", "ws-A");
    expect(next.map((w) => w.name)).toEqual(["C", "A", "B"]);
    expect(reorderWorkspaces(next, "ws-C", "ws-B").map((w) => w.name)).toEqual(["A", "B", "C"]);
    expect(reorderWorkspaces(all, "missing", "ws-A")).toBe(all);
    expect(reorderWorkspaces(all, "ws-A", "ws-A")).toBe(all);
  });

  it("persists rail order without changing the active workspace", async () => {
    useWorkspaceStore.setState({
      workspaces: [workspace("A", []), workspace("B", [])],
      activeWorkspaceId: "ws-A",
    });
    useWorkspaceStore.getState().moveWorkspace("ws-B", "ws-A");
    await useWorkspaceStore.persist.rehydrate();
    expect(useWorkspaceStore.getState().workspaces.map((w) => w.name)).toEqual(["B", "A"]);
    expect(useWorkspaceStore.getState().activeWorkspaceId).toBe("ws-A");
  });
});
