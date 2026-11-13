# Wake an asleep Instance from Conn (conn#80): real-app check on the mini

Re-run after the review fixes, 23:16–23:52 UTC on head 6be8cc7094 plus the round-2 fixes (head 7696671d2a). Clicks are real CDP mouse events, because a wake needs user input in the window. The shots 10, 20, 21, 31, 32, 70 and 71 are from that re-run.

Taken on 13 Nov 2026, 22:46–23:05 UTC, from the real Conn dev app on the mini (own clone `/Volumes/Data/nckrtl/.cache/conn-slice-wake/repo`, CDP port 9481, own home). Default dark theme, Orbit mode, no profile linked. Screenshots only through CDP `Page.captureScreenshot` (1280×820, scale 2).

Set-up (nothing on Orbit, no live call):
- The Gateway was a local mock (`../tools/mock-gateway.mjs`, 127.0.0.1:8981). The dev app pointed at it through an uncommitted one-line change of `DEFAULT_ORBIT_GATEWAY_URL`, which was reverted before the commit.
- The "Instance" was a real T3 server from the same commit (127.0.0.1:13811, own home). Conn paired with it through the mock's pairing route.
- "Asleep" = `SIGSTOP` of that server, as a frozen container: the port accepts connections and never answers. The mock lists it as `power_state: stopped`.
- The wake (`POST /api/v1/instances/901/wake`) sends `SIGCONT`. Its modes: fast (202 with a succeeded Operation), slow (pending, resumes after 3 s), fail (the Operation fails with `instance.t3_unready`) and 404 (an older Gateway).
- Timings come from `../tools/timeline.mjs`, which polls the app's own connection state every 250 ms.

## Pictures
- `10-instances-asleep.png`: the Orbit panel's Instances page with the asleep Instance, read while the window showed Pull Requests. Yellow dot, "Stopped", and the New thread button stays usable. No wake call: list reads and renders woke nothing over several syncs.
- `60-palette-instance-step-asleep.png`: the palette's Instance step: "beast · Stopped · wake-clone.create-bench.test · 1 thread", pickable. Showing it woke nothing. Picking it woke the Instance once, and Conn was connected 0.43 s later.
- `20-waking.png`: a slow wake (3 s) after "New thread in this Instance". The view shows today's "mini is reconnecting" banner, which appears after its grace period (2.3 s).
- `21-woken.png`: 0.9 s after the resume: connected, no banner.
- `31-thread-opening.png`, `32-thread-open.png`: an existing thread of the asleep Instance opened from the sidebar (fast wake). One wake call; connected 1.07 s after the click; no banner at any time.
- `40-wake-failed-4s.png`, `41-wake-failed-24s.png`: a failed wake. Today's display: "mini is reconnecting", with today's retries and backoff. Conn asks for a wake again at most every 30 s while the view shows the Instance.
- `50-old-gateway-instances.png`: an older Gateway (the wake answers 404). The connection keeps today's behaviour. The row's New thread button is blocked again with today's reason, "Orbit cannot start a stopped Instance yet" (`aria-disabled=true`; the tooltip shows on hover).
- `before-fix/`: the first run, at head e02d141965. A route swap parked the Instance again during its wake, so it showed "mini is offline" until the next list read (about 21 s). Fixed in 34e94b0c7e; every run above is at that head.

- `70-idle-window-parked.png`: a thread of the Instance open, then no input for 5.5 min, then a freeze. Within 11 s Conn holds it off with no wake call and no banner.
- `71-idle-window-after-input.png`: one click into the window woke it; connected 0.5 s later.

## Measured
- Not in use: parked within one list read (8.8–22 s after the freeze). The connection reads `available`, not a failure, and no connect hangs.
- Frozen under an open, connected thread: the socket went silent and dropped after 16.6 s. Conn woke the Instance and was connected 0.3 s later, with no banner.
- One wake per use: each scenario logged exactly one wake call at the mock (failed wakes: one per 30 s at most).
