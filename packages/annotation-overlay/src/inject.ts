import {
  ANNOTATION_OVERLAY_GLOBAL,
  ANNOTATION_OVERLAY_OPTIONS_GLOBAL,
} from "@t3tools/shared/annotationBridge";
import { setAnnotationMode } from "./actions";
import { getAnnotationState, subscribeAnnotationState } from "./host-controls";
import { mountAnnotation, type AnnotationOptions } from "./index";
import { annotationMode } from "./state";

const overlay = {
  mount: mountAnnotation,
  /** Turns annotation mode on or off; returns the new state. */
  setMode: (active: boolean) => {
    if (annotationMode.value !== active) setAnnotationMode(active);
    return annotationMode.value;
  },
  getState: getAnnotationState,
  subscribe: subscribeAnnotationState,
};

type Overlay = typeof overlay;
const page = window as unknown as Record<string, unknown>;
const options = () => (page[ANNOTATION_OVERLAY_OPTIONS_GLOBAL] ?? {}) as AnnotationOptions;

// A second copy would take every click while the first renders, so a later load only
// passes its options on.
const running = page[ANNOTATION_OVERLAY_GLOBAL] as Overlay | undefined;
if (running) {
  running.mount(options());
} else {
  page[ANNOTATION_OVERLAY_GLOBAL] = overlay;
  const start = () => mountAnnotation(options());
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", start, { once: true });
  } else {
    start();
  }
}
