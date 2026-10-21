import { scopeProjectRef } from "@t3tools/client-runtime/environment";
import {
  EnvironmentId,
  ProjectId,
  ProviderInstanceId,
  type ModelSelection,
} from "@t3tools/contracts";
import { afterEach, describe, expect, it } from "vite-plus/test";
import { useWorkspaceStore } from "../workspaceStore";
import {
  resolveThreadActionProjectRef,
  resolveNewThreadModelSelectionOverride,
  type ChatThreadActionContext,
} from "./chatThreadActions";

const ENVIRONMENT_ID = EnvironmentId.make("environment-1");
const PROJECT_ID = ProjectId.make("project-1");
const FALLBACK_PROJECT_ID = ProjectId.make("project-2");
function createContext(overrides: Partial<ChatThreadActionContext> = {}): ChatThreadActionContext {
  return {
    activeDraftThread: null,
    activeThread: undefined,
    defaultProjectRef: scopeProjectRef(ENVIRONMENT_ID, FALLBACK_PROJECT_ID),
    handleNewThread: async () => {},
    ...overrides,
  };
}

const PROJECT_DEFAULT_SELECTION: ModelSelection = {
  instanceId: ProviderInstanceId.make("codex"),
  model: "project-default",
};
const CARRIED_SELECTION: ModelSelection = {
  instanceId: ProviderInstanceId.make("codex"),
  model: "carried-model",
};

describe("chatThreadActions", () => {
  it("does not carry a non-explicit model from the destination draft back into itself", () => {
    expect(
      resolveNewThreadModelSelectionOverride({
        projectDefaultSelection: null,
        carrySelection: CARRIED_SELECTION,
        carrySourceDraftId: "draft-a",
        destinationDraftId: "draft-a",
      }),
    ).toBeNull();
  });

  it("keeps the project default above any carried selection", () => {
    expect(
      resolveNewThreadModelSelectionOverride({
        projectDefaultSelection: PROJECT_DEFAULT_SELECTION,
        carrySelection: CARRIED_SELECTION,
        carrySourceDraftId: "draft-a",
        destinationDraftId: "draft-b",
      }),
    ).toEqual(PROJECT_DEFAULT_SELECTION);
  });
});

describe("new threads inside a workspace", () => {
  afterEach(() =>
    useWorkspaceStore.setState({ workspaces: [], activeWorkspaceId: null, availableProjects: [] }),
  );

  it("skips a context project outside the selected workspace", () => {
    useWorkspaceStore.setState({
      workspaces: [
        { id: "ws-1", name: "Desk", projectKeys: ["repo:fallback"], color: "teal", icon: null },
      ],
      activeWorkspaceId: "ws-1",
      availableProjects: [
        {
          projectKey: "repo:active",
          displayName: "active",
          refs: [`${ENVIRONMENT_ID}:${PROJECT_ID}`],
        },
        {
          projectKey: "repo:fallback",
          displayName: "fallback",
          refs: [`${ENVIRONMENT_ID}:${FALLBACK_PROJECT_ID}`],
        },
      ],
    });
    const context = createContext({
      activeThread: {
        environmentId: ENVIRONMENT_ID,
        projectId: PROJECT_ID,
      } as ChatThreadActionContext["activeThread"],
    });
    expect(resolveThreadActionProjectRef(context)).toEqual(
      scopeProjectRef(ENVIRONMENT_ID, FALLBACK_PROJECT_ID),
    );

    useWorkspaceStore.setState({ activeWorkspaceId: null });
    expect(resolveThreadActionProjectRef(context)).toEqual(
      scopeProjectRef(ENVIRONMENT_ID, PROJECT_ID),
    );
  });
});
