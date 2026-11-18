import {
  scopedThreadKey,
  scopeProjectRef,
  scopeThreadRef,
} from "@t3tools/client-runtime/environment";
import { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import {
  applyOtherWindowComposerDrafts,
  COMPOSER_DRAFT_STORAGE_KEY,
  composerTargetKey,
  captureOrbitDraftRevision,
  clearAcceptedOrbitDraft,
  DraftId,
  isStaleClearedOrbitDraft,
  prepareOrbitDraftAdmission,
  useComposerDraftStore,
} from "./composerDraftStore";
import { RecentKeyChanges } from "./lib/desktopWindowContext";
import { orbitDraftLogicalProjectKey, orbitDraftProjectId } from "./orbit/orbitDraft";

const ENVIRONMENT_ID = EnvironmentId.make("environment-local");
const first = scopeThreadRef(ENVIRONMENT_ID, ThreadId.make("thread-first"));
const second = scopeThreadRef(ENVIRONMENT_ID, ThreadId.make("thread-second"));

function reset() {
  useComposerDraftStore.setState({
    draftsByThreadKey: {},
    draftThreadsByThreadKey: {},
    logicalProjectDraftThreadKeyByLogicalProjectKey: {},
    stickyModelSelectionByProvider: {},
    stickyActiveProvider: null,
  });
}

/** What another window would write: this window's stored value, edited. */
async function otherWindowWrite(
  edit: (drafts: Record<string, { prompt: string }>) => void,
): Promise<string> {
  await vi.advanceTimersByTimeAsync(300);
  const stored = (await useComposerDraftStore.persist
    .getOptions()
    .storage!.getItem(COMPOSER_DRAFT_STORAGE_KEY)) as {
    state: { draftsByThreadKey: Record<string, { prompt: string }> };
    version: number;
  };
  const value = structuredClone(stored);
  edit(value.state.draftsByThreadKey);
  return JSON.stringify(value);
}

function promptOf(ref: typeof first): string | undefined {
  return useComposerDraftStore.getState().draftsByThreadKey[scopedThreadKey(ref)]?.prompt;
}

describe("applyOtherWindowComposerDrafts", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    reset();
  });
  afterEach(() => {
    vi.useRealTimers();
    reset();
  });

  it("persists an accepted Orbit draft clear without waiting for the debounce", async () => {
    const draftId = DraftId.make("orbit-draft");
    const storage = useComposerDraftStore.persist.getOptions().storage!;
    useComposerDraftStore.getState().setPrompt(draftId, "accepted by Orbit");
    await otherWindowWrite(() => {});
    clearAcceptedOrbitDraft(draftId);
    expect(JSON.stringify(await storage.getItem(COMPOSER_DRAFT_STORAGE_KEY))).not.toContain(
      "accepted by Orbit",
    );
  });

  it("keeps a newer draft written by a second window before Orbit acknowledges the first", async () => {
    const draftId = DraftId.make("orbit-other-window-draft");
    const storage = useComposerDraftStore.persist.getOptions().storage!;
    useComposerDraftStore.getState().setPrompt(draftId, "accepted by Orbit");
    const raw = await otherWindowWrite((drafts) => {
      Object.values(drafts).find((draft) => draft.prompt === "accepted by Orbit")!.prompt =
        "edited in a second window";
    });
    await storage.setItem(COMPOSER_DRAFT_STORAGE_KEY, JSON.parse(raw));
    await vi.advanceTimersByTimeAsync(300);
    useComposerDraftStore.getState().setPrompt(first, "different draft in this window");
    await vi.advanceTimersByTimeAsync(300);
    const captured = captureOrbitDraftRevision(draftId);
    expect(prepareOrbitDraftAdmission(draftId, captured)).toBe(false);
    clearAcceptedOrbitDraft(draftId);
    expect(await storage.getItem(COMPOSER_DRAFT_STORAGE_KEY)).toMatchObject({
      state: { orbitDraftClearRevisions: { [composerTargetKey(draftId)]: [captured] } },
    });
    expect(JSON.stringify(await storage.getItem(COMPOSER_DRAFT_STORAGE_KEY))).toContain(
      "edited in a second window",
    );
    applyOtherWindowComposerDrafts(raw, new RecentKeyChanges(2_000));
    expect(useComposerDraftStore.getState().getComposerDraft(draftId)?.prompt).toBe(
      "edited in a second window",
    );
    expect(isStaleClearedOrbitDraft(draftId, captured)).toBe(true);
  });

  it("flushes the captured draft before admission and preserves a peer edit back to the prior text", async () => {
    const draftId = DraftId.make("orbit-restore-prior-text");
    const store = useComposerDraftStore.getState();
    store.setPrompt(draftId, "previous text");
    const earlier = await otherWindowWrite(() => {});
    store.setPrompt(draftId, "text actually sent");
    expect(prepareOrbitDraftAdmission(draftId, captureOrbitDraftRevision(draftId))).toBe(true);
    const storage = useComposerDraftStore.persist.getOptions().storage!;
    expect(JSON.stringify(await storage.getItem(COMPOSER_DRAFT_STORAGE_KEY))).toContain(
      "text actually sent",
    );
    await storage.setItem(COMPOSER_DRAFT_STORAGE_KEY, JSON.parse(earlier));
    await vi.advanceTimersByTimeAsync(300);
    clearAcceptedOrbitDraft(draftId);
    expect(JSON.stringify(await storage.getItem(COMPOSER_DRAFT_STORAGE_KEY))).toContain(
      "previous text",
    );
  });

  it("does not write a passively received draft over a newer peer revision during Send", async () => {
    const draftId = DraftId.make("orbit-peer-revisions");
    const key = composerTargetKey(draftId);
    const store = useComposerDraftStore.getState();
    store.setLogicalProjectDraftThreadId(
      orbitDraftLogicalProjectKey(66),
      scopeProjectRef(ENVIRONMENT_ID, orbitDraftProjectId(66)),
      draftId,
      {
        orbitTarget: {
          projectId: 66,
          projectSlug: "create-bench",
          projectName: "Create bench",
          nodeName: "beast",
          instanceKind: "new",
          instanceName: "first-target",
          existing: null,
          domainSuffix: ".create-bench.test",
        },
      },
    );
    store.setPrompt(draftId, "First locally saved revision");
    await vi.advanceTimersByTimeAsync(300);
    const storage = useComposerDraftStore.persist.getOptions().storage!;
    const first = await storage.getItem(COMPOSER_DRAFT_STORAGE_KEY);
    if (!first || "capturedState" in first.state) throw new Error("Expected a stored draft");
    const draft = first.state.draftsByThreadKey[key]!;
    const session = first.state.draftThreadsByThreadKey[key]!;
    const peerEdit = (prompt: string, instanceName: string) => ({
      ...first,
      state: {
        ...first.state,
        draftsByThreadKey: { [key]: { ...draft, prompt } },
        draftThreadsByThreadKey: {
          [key]: { ...session, orbitTarget: { ...session.orbitTarget!, instanceName } },
        },
      },
    });
    const previous = peerEdit("Passively received revision", "previous-target");
    applyOtherWindowComposerDrafts(JSON.stringify(previous), new RecentKeyChanges(2_000));
    const captured = captureOrbitDraftRevision(draftId);
    const current = peerEdit("Newest peer revision", "current-target");
    await storage.setItem(COMPOSER_DRAFT_STORAGE_KEY, current);
    await vi.advanceTimersByTimeAsync(300);

    expect(prepareOrbitDraftAdmission(draftId, captured)).toBe(false);
    expect(await storage.getItem(COMPOSER_DRAFT_STORAGE_KEY)).toMatchObject(current);
  });

  it.each([
    "prompt",
    "target",
    "unchanged",
    "saved-original",
    "other-window-edit",
    "passive-clear",
    "discard-received",
    "acknowledge-received",
    "first-acknowledge-received",
  ])(
    "reconciles an Orbit %s draft when another window clears a newer sent version",
    async (editedField) => {
      const draftId = DraftId.make(`orbit-draft-${editedField}`);
      const key = composerTargetKey(draftId);
      const projectKey = orbitDraftLogicalProjectKey(66);
      const store = useComposerDraftStore.getState();
      store.setLogicalProjectDraftThreadId(
        projectKey,
        scopeProjectRef(ENVIRONMENT_ID, orbitDraftProjectId(66)),
        draftId,
        {
          orbitTarget: {
            projectId: 66,
            projectSlug: "create-bench",
            projectName: "Create bench",
            nodeName: "beast",
            instanceKind: "new",
            instanceName: "isolated-test",
            existing: null,
            domainSuffix: ".create-bench.test",
          },
        },
      );
      store.setPrompt(draftId, "original");
      await vi.advanceTimersByTimeAsync(300);
      const storage = useComposerDraftStore.persist.getOptions().storage!;
      const original = await storage.getItem(COMPOSER_DRAFT_STORAGE_KEY);
      const passive = !["prompt", "target"].includes(editedField);
      if (passive) {
        store.setPrompt(draftId, "later revision sent in the other window");
        await vi.advanceTimersByTimeAsync(300);
      }
      clearAcceptedOrbitDraft(draftId);
      const external = structuredClone(await storage.getItem(COMPOSER_DRAFT_STORAGE_KEY));
      if (!external || "capturedState" in external.state)
        throw new Error("Expected a stored draft clear");
      expect(external.state.orbitDraftClearRevisions?.[key]).toEqual([
        expect.stringMatching(/^[0-9a-f]{64}$/),
      ]);
      applyOtherWindowComposerDrafts(JSON.stringify(original), new RecentKeyChanges(2_000));

      if (editedField === "prompt") {
        store.setPrompt(draftId, "edited here");
      } else if (editedField === "target") {
        const target = store.getDraftSession(draftId)?.orbitTarget;
        if (!target) throw new Error("Expected an Orbit draft");
        store.setDraftThreadContext(draftId, {
          orbitTarget: { ...target, instanceName: "changed-target" },
        });
      }
      if (editedField === "saved-original") {
        await storage.setItem(COMPOSER_DRAFT_STORAGE_KEY, original!);
        await vi.advanceTimersByTimeAsync(300);
        store.setPrompt(draftId, "earlier draft saved by this window");
        await vi.advanceTimersByTimeAsync(300);
      }
      if (
        [
          "other-window-edit",
          "passive-clear",
          "discard-received",
          "acknowledge-received",
          "first-acknowledge-received",
        ].includes(editedField)
      ) {
        if (editedField !== "other-window-edit")
          applyOtherWindowComposerDrafts(JSON.stringify(external), new RecentKeyChanges(2_000));
        if (!original || "capturedState" in original.state)
          throw new Error("Expected a stored draft");
        const draft = original.state.draftsByThreadKey[key]!;
        const session = original.state.draftThreadsByThreadKey[key]!;
        const changedBranch = {
          ...Object.fromEntries(Object.entries(session).reverse()),
          branch: "topic/edited",
        } as typeof session;
        await storage.setItem(COMPOSER_DRAFT_STORAGE_KEY, {
          ...original,
          state: {
            ...original.state,
            draftsByThreadKey: { [key]: { ...draft, prompt: "genuine edit in a third window" } },
            draftThreadsByThreadKey: { [key]: changedBranch },
            orbitDraftClearRevisions:
              editedField === "first-acknowledge-received"
                ? {}
                : (external.state.orbitDraftClearRevisions ?? {}),
          },
        });
        await vi.advanceTimersByTimeAsync(300);
        if (editedField !== "first-acknowledge-received")
          expect(isStaleClearedOrbitDraft(draftId)).toBe(true);
        useComposerDraftStore.setState({});
        await vi.advanceTimersByTimeAsync(300);
        const latest = await storage.getItem(COMPOSER_DRAFT_STORAGE_KEY);
        expect(latest).toMatchObject({
          state: { draftsByThreadKey: { [key]: { prompt: "genuine edit in a third window" } } },
        });
        if (editedField.endsWith("received")) {
          applyOtherWindowComposerDrafts(JSON.stringify(latest), new RecentKeyChanges(2_000));
          expect(useComposerDraftStore.getState().getDraftSession(draftId)).not.toBeNull();
          if (editedField === "discard-received") store.clearDraftThread(draftId);
          else clearAcceptedOrbitDraft(draftId);
          await vi.advanceTimersByTimeAsync(300);
          expect(await storage.getItem(COMPOSER_DRAFT_STORAGE_KEY)).toMatchObject({
            state: {
              draftsByThreadKey: {},
              draftThreadsByThreadKey: {},
              logicalProjectDraftThreadKeyByLogicalProjectKey: {},
            },
          });
        }
        return;
      }
      await storage.setItem(COMPOSER_DRAFT_STORAGE_KEY, external);
      await vi.advanceTimersByTimeAsync(300);
      let time = 0;
      const changes = new RecentKeyChanges(2_000, () => time);
      changes.mark(`${editedField === "prompt" ? "d" : "t"}:${key}`);
      time = 2_001;
      expect(isStaleClearedOrbitDraft(draftId)).toBe(passive);
      applyOtherWindowComposerDrafts(JSON.stringify(external), changes);
      if (passive) {
        expect(useComposerDraftStore.getState().getDraftSession(draftId)).toBeNull();
        await vi.advanceTimersByTimeAsync(300);
        const persisted = await storage.getItem(COMPOSER_DRAFT_STORAGE_KEY);
        expect(persisted).toMatchObject({
          state: {
            draftsByThreadKey: {},
            draftThreadsByThreadKey: {},
            logicalProjectDraftThreadKeyByLogicalProjectKey: {},
          },
        });
        return;
      }

      const expectedPrompt = editedField === "prompt" ? "edited here" : "original";
      const instanceName = editedField === "target" ? "changed-target" : "isolated-test";
      const after = useComposerDraftStore.getState();
      expect(after.getComposerDraft(draftId)?.prompt).toBe(expectedPrompt);
      expect(after.getDraftSession(draftId)?.orbitTarget?.instanceName).toBe(instanceName);
      expect(after.logicalProjectDraftThreadKeyByLogicalProjectKey[projectKey]).toBe(draftId);

      await vi.advanceTimersByTimeAsync(300);
      const persisted = await storage.getItem(COMPOSER_DRAFT_STORAGE_KEY);
      expect(persisted).toMatchObject({
        state: {
          draftsByThreadKey: { [key]: { prompt: expectedPrompt } },
          draftThreadsByThreadKey: { [key]: { orbitTarget: { projectId: 66, instanceName } } },
          logicalProjectDraftThreadKeyByLogicalProjectKey: { [projectKey]: draftId },
        },
      });
    },
  );

  it("takes in drafts another window added, changed or sent", async () => {
    useComposerDraftStore.getState().setPrompt(first, "draft in this window");
    const raw = await otherWindowWrite((drafts) => {
      drafts[scopedThreadKey(first)]!.prompt = "edited in the other window";
      drafts[scopedThreadKey(second)] = { ...drafts[scopedThreadKey(first)]!, prompt: "new" };
    });
    applyOtherWindowComposerDrafts(raw, new RecentKeyChanges(2_000));
    expect(promptOf(first)).toBe("edited in the other window");
    expect(promptOf(second)).toBe("new");

    const sent = await otherWindowWrite((drafts) => {
      delete drafts[scopedThreadKey(second)];
    });
    applyOtherWindowComposerDrafts(sent, new RecentKeyChanges(2_000));
    expect(promptOf(second)).toBeUndefined();
    expect(promptOf(first)).toBe("edited in the other window");
  });

  it("keeps a draft this window is editing", async () => {
    useComposerDraftStore.getState().setPrompt(first, "typing here");
    const raw = await otherWindowWrite((drafts) => {
      drafts[scopedThreadKey(first)]!.prompt = "older copy";
    });
    const changes = new RecentKeyChanges(2_000);
    changes.mark(`d:${scopedThreadKey(first)}`);
    applyOtherWindowComposerDrafts(raw, changes);
    expect(promptOf(first)).toBe("typing here");
  });

  it("ignores writes from another storage version", async () => {
    useComposerDraftStore.getState().setPrompt(first, "kept");
    const raw = await otherWindowWrite((drafts) => {
      drafts[scopedThreadKey(first)]!.prompt = "other version";
    });
    const value = JSON.parse(raw) as { version: number };
    value.version += 1;
    applyOtherWindowComposerDrafts(JSON.stringify(value), new RecentKeyChanges(2_000));
    expect(promptOf(first)).toBe("kept");
  });
});
