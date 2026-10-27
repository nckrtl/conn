// Defines the @nckrtl/annotator host on the page (the preload shares its window) before the
// overlay loads, so its `host` dictation provider asks main instead of fetching from the page.
import { ipcRenderer } from "electron";

import { makeAnnotatorHost } from "./AnnotatorDictation.ts";
import { ANNOTATOR_DICTATION_CHANNEL } from "./GuestProtocol.ts";

(window as { __ANNOTATOR_HOST__?: unknown }).__ANNOTATOR_HOST__ = makeAnnotatorHost((action) =>
  ipcRenderer.invoke(ANNOTATOR_DICTATION_CHANNEL, action),
);
