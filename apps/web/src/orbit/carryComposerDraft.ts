import {
  composerDraftHasUserContent,
  type DraftId,
  useComposerDraftStore,
} from "../composerDraftStore";

/**
 * Conn: moves what the user typed in one draft into another, when a pick in an Orbit draft opens a
 * different draft (the branch menu's "in instance" row for a paired Instance). The prompt and
 * attachments move; a model the user picked and the runtime and interaction modes are copied when
 * the source draft holds them. The same draft on both sides, or nothing typed, changes nothing.
 */
export function carryComposerDraft(from: DraftId, to: DraftId): void {
  if (from === to) return;
  const store = useComposerDraftStore.getState();
  const source = store.getComposerDraft(from);
  // The move replaces the target's prompt: an empty source must not erase text left there.
  if (!composerDraftHasUserContent(source)) return;
  // A model the user never picked yields to the Instance project's default.
  const model =
    source.modelSelectionExplicit === true && source.activeProvider !== null
      ? (source.modelSelectionByProvider[source.activeProvider] ?? null)
      : null;
  store.moveComposerPromptAndImages(from, to);
  if (model !== null) {
    store.setModelSelection(to, model, { explicit: true });
  }
  if (source.runtimeMode !== null) store.setRuntimeMode(to, source.runtimeMode);
  if (source.interactionMode !== null) store.setInteractionMode(to, source.interactionMode);
}
