import { EnvironmentId, ProjectId, ProviderInstanceId } from "@t3tools/contracts";
import { scopeProjectRef } from "@t3tools/client-runtime/environment";
import { describe, expect, it } from "vite-plus/test";

import { DraftId, useComposerDraftStore } from "../composerDraftStore";
import { formatInlineContextReference } from "../lib/composerContextReferences";
import { carryComposerDraft } from "./carryComposerDraft";

const orbitDraft = DraftId.make("draft-orbit");
const instanceDraft = DraftId.make("draft-instance");
const model = { instanceId: ProviderInstanceId.make("claude"), model: "claude-opus-5-5" };

function setup() {
  useComposerDraftStore.setState({
    draftsByThreadKey: {},
    draftThreadsByThreadKey: {},
    logicalProjectDraftThreadKeyByLogicalProjectKey: {},
  });
  const store = useComposerDraftStore.getState();
  store.setProjectDraftThreadId(
    scopeProjectRef(EnvironmentId.make("env-primary"), ProjectId.make("orbit-71")),
    orbitDraft,
  );
  store.setProjectDraftThreadId(
    scopeProjectRef(EnvironmentId.make("clone-71"), ProjectId.make("ws")),
    instanceDraft,
  );
  return store;
}

describe("carryComposerDraft", () => {
  it("moves the prompt and copies the model and modes into the paired Instance's draft", () => {
    const store = setup();
    store.setPrompt(orbitDraft, "Fix the login form");
    store.setModelSelection(orbitDraft, model, { explicit: true });
    store.setRuntimeMode(orbitDraft, "approval-required");
    store.setInteractionMode(orbitDraft, "plan");

    carryComposerDraft(orbitDraft, instanceDraft);

    const state = useComposerDraftStore.getState();
    expect(state.getComposerDraft(instanceDraft)).toMatchObject({
      prompt: "Fix the login form",
      activeProvider: "claude",
      modelSelectionByProvider: { claude: model },
      runtimeMode: "approval-required",
      interactionMode: "plan",
    });
    expect(state.getComposerDraft(orbitDraft)?.prompt ?? "").toBe("");
  });

  it("leaves a model the user never picked to the Instance's project", () => {
    const store = setup();
    store.setPrompt(orbitDraft, "Fix the login form");
    store.setModelSelection(orbitDraft, model);
    carryComposerDraft(orbitDraft, instanceDraft);
    expect(
      useComposerDraftStore.getState().getComposerDraft(instanceDraft)?.modelSelectionByProvider,
    ).toEqual({});
  });

  it("keeps text left in the Instance's draft when nothing was typed in the Orbit draft", () => {
    const store = setup();
    store.setPrompt(instanceDraft, "Earlier note");
    store.setRuntimeMode(orbitDraft, "approval-required");
    carryComposerDraft(orbitDraft, instanceDraft);
    // A context chip alone is no typed text either.
    store.setPrompt(
      orbitDraft,
      formatInlineContextReference({ kind: "thread", contextId: "thread_1", label: "Login" }),
    );
    carryComposerDraft(orbitDraft, instanceDraft);
    expect(useComposerDraftStore.getState().getComposerDraft(instanceDraft)?.prompt).toBe(
      "Earlier note",
    );
  });

  it("keeps the prompt where it is when the pick reopened the same draft", () => {
    const store = setup();
    store.setPrompt(orbitDraft, "Fix the login form");
    carryComposerDraft(orbitDraft, orbitDraft);
    expect(useComposerDraftStore.getState().getComposerDraft(orbitDraft)?.prompt).toBe(
      "Fix the login form",
    );
  });
});
