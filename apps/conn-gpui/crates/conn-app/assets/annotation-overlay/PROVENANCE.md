# Conn Annotation Overlay (`inject.js`)

`inject.js` is frozen and hand-owned. Edit it here; nothing regenerates it.

- **Last built from:** `packages/annotation-overlay/dist/inject.js` (`vp build`, a self-contained IIFE) at
  `93dda184da382af9cd06062da11bbdcbe9e4ec5e` (#169). Its PR branch built it at `52495101c64f`.
- **Source package:** `@t3tools/annotation-overlay`. It leaves the repo with the TypeScript stack and stays
  readable at the `t3-final` tag (`git show t3-final:packages/annotation-overlay/src/inject.ts`).
- **Larger changes:** rebuild in a `t3-final` worktree, then copy `dist/inject.js` here and record the commit.

## Bridge contract expected by `inject.js`

Provided by `crates/conn-app/src/panels/browser_overlay_bridge.js` over CEF's suppressed `__CONN_OVERLAY_RPC__:` console bridge:

- `window.__CONN_ANNOTATIONS__`: `{ list(), submit(capture), remove(ids), subscribe(onChange) }` + `window.__connAnnotationsChanged()`
- `window.__ANNOTATOR_HOST__`: `{ dictation(action, { signal }), dictationSession(action, session, { signal }) }` -> `conn_desktop::operator::OperatorClient` with the page's `Origin` header
- `window.__CONN_CAPTURE_HOOK__`: `(rect) => Promise<string>` -> crops CEF's Retina BGRA frame buffer to a PNG data URL
- `window.ConnAnnotationOverlay`: `.mount(options)`, `.setMode(active)`, `.getState()`, `.subscribe(cb)`
