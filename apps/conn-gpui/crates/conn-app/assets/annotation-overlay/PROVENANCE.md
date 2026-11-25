# Conn Annotation Overlay (`inject.js`)

- **Source:** `packages/annotation-overlay/dist/inject.js`, built with `vp build` in `packages/annotation-overlay`
- **Source commit:** `52495101c64fac136e5f9afcfba0969b191fa10a`
- **Package:** `@t3tools/annotation-overlay` (`vite.config.ts` self-contained IIFE)

## Bridge contract expected by `inject.js`

Provided by `crates/conn-app/src/panels/browser_overlay_bridge.js` over CEF's suppressed `__CONN_OVERLAY_RPC__:` console bridge:

- `window.__CONN_ANNOTATIONS__`: `{ list(), submit(capture), remove(ids), subscribe(onChange) }` + `window.__connAnnotationsChanged()`
- `window.__ANNOTATOR_HOST__`: `{ dictation(action, { signal }), dictationSession(action, session, { signal }) }` -> `conn_desktop::operator::OperatorClient` with the page's `Origin` header
- `window.__CONN_CAPTURE_HOOK__`: `(rect) => Promise<string>` -> crops CEF's Retina BGRA frame buffer to a PNG data URL
- `window.ConnAnnotationOverlay`: `.mount(options)`, `.setMode(active)`, `.getState()`, `.subscribe(cb)`
