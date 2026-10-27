export const START_PICK_CHANNEL = "preview:start-pick";
export const CANCEL_PICK_CHANNEL = "preview:cancel-pick";
export const ELEMENT_PICKED_CHANNEL = "preview:element-picked";
export const ANNOTATION_CAPTURED_CHANNEL = "preview:annotation-captured";
export const ANNOTATION_THEME_CHANNEL = "preview:annotation-theme";
export const ANNOTATION_SEND_ENABLED_CHANNEL = "preview:annotation-send-enabled";
export const HUMAN_INPUT_CHANNEL = "preview:human-input";
export const MOUSE_NAVIGATE_CHANNEL = "preview:mouse-navigate";
export const RECORDING_CURSOR_CHANNEL = "preview:recording-cursor";
export const RECORDING_POINTER_CHANNEL = "preview:recording-pointer";
export const RECORDING_KEY_CHANNEL = "preview:recording-key";
export const RECORDING_INPUT_CHANNEL = "preview:recording-input";
export const RECORDING_CONTROLLER_CHANNEL = "preview:recording-controller";
export const PASSKEY_CREATE_CHANNEL = "preview:passkey-create";
export const PASSKEY_GET_CHANNEL = "preview:passkey-get";
export const PASSKEY_BRIDGE_ARGUMENT = "--t3code-preview-passkey-bridge";
/** Guest → main (invoke): the toolbar payload of the guest's document, from its response headers. */
export const LARAVEL_TOOLBAR_DOCUMENT_CHANNEL = "preview:laravel-toolbar-document";
/** Main → guest: the toolbar payload of a later fetch or XHR response. */
export const LARAVEL_TOOLBAR_RESPONSE_CHANNEL = "preview:laravel-toolbar-response";
/**
 * Guest → main (invoke): POST the tab's registered dictation URL for "start" or "stop", or,
 * with a session id, `{ session }` to its `/dictate/start|stop|cancel`.
 */
export const ANNOTATOR_DICTATION_CHANNEL = "preview:annotator-dictation";
