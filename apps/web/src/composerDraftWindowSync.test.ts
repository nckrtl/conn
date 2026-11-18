import { scopedThreadKey, scopeThreadRef } from "@t3tools/client-runtime/environment";
import { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import {
  applyOtherWindowComposerDrafts,
  COMPOSER_DRAFT_STORAGE_KEY,
  clearAcceptedOrbitDraft,
  DraftId,
  useComposerDraftStore,
} from "./composerDraftStore";
import { RecentKeyChanges } from "./lib/desktopWindowContext";

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
    const draftId = DraftId.make("orbit-draft");
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
    clearAcceptedOrbitDraft(draftId);
    expect(JSON.stringify(await storage.getItem(COMPOSER_DRAFT_STORAGE_KEY))).toContain(
      "edited in a second window",
    );
    applyOtherWindowComposerDrafts(raw, new RecentKeyChanges(2_000));
    expect(useComposerDraftStore.getState().getComposerDraft(draftId)?.prompt).toBe(
      "edited in a second window",
    );
  });

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
