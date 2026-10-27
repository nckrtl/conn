import { configureAnnotationService } from "./sync";
import { connTransport, type ConnAnnotations } from "./transport";
import { configureToolbarData, type ToolbarData } from "./core/request-history";
import { configureHostHooks, type AnnotationMetadataHook, type CaptureHook } from "./hooks";
import { ensureAnnotationRuntime, teardownAnnotationRuntime } from "./runtime";
import type { DictationInput } from "./dictation-settings";

export type AnnotationOptions = {
  floatingControl?: boolean;
  /** Extra context stored on each new annotation, such as a host session id. */
  metadata?: AnnotationMetadataHook;
  /** Supply real pixels for the screenshot, for example from Electron or CDP. */
  capture?: CaptureHook;
  dictation?: DictationInput;
  getToolbarData?: () => ToolbarData;
};

let connectedTo: ConnAnnotations | undefined;

/** Mount once per page; repeated calls update configuration without duplicating controls. */
export function mountAnnotation(options: AnnotationOptions = {}) {
  configureHostHooks(options);
  const conn = window.__CONN_ANNOTATIONS__;
  if (conn !== connectedTo || conn === undefined) {
    connectedTo = conn;
    configureAnnotationService(connTransport());
  }
  configureToolbarData(options.getToolbarData);
  ensureAnnotationRuntime(options);
  return { destroy: teardownAnnotationRuntime };
}

export { setAnnotationMode, toggleAnnotationMode } from "./actions";
export { getAnnotationState, subscribeAnnotationState } from "./host-controls";
