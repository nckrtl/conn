# iOS thread rendering check

Compare the completed delegated report in **Conn iOS WireGuard Launch Experience** with the browser lab. The native seed and the lab must use the same report title, Markdown body and assistant reply. The lab renders the report as an agent message whose sender is the child title. Capture it collapsed at the newest message, with an empty composer and no sheet. Use English, Dark Ocean, a 402 × 874 pt portrait screen, standard display zoom and default (Large) iOS Dynamic Type. Save the whole screen as PNG at its original scale.

## Reproduce

Use two checkouts on the test Mac. Run the harness from the QA commit under review. Serve the lab from commit `30d117b3651cd8122ca89bfdeec0c30826cf952b`. That merge includes the 16 px / 24 px typography change from `6b26242f547b67fb8e73dc11d572803c87bfef61` and the attachment composer from #368. Integration PR [#371](https://github.com/nckrtl/conn/pull/371) carries the combined lab to `main`. This check uses the immutable merge even after the target branch moves.

From the root of the clean QA checkout, start the pinned lab in one terminal (Node 24 and Corepack):

```sh
LAB_SHA=30d117b3651cd8122ca89bfdeec0c30826cf952b
git fetch origin "$LAB_SHA"
git worktree add --detach ../conn-thread-qa-lab "$LAB_SHA"
cd ../conn-thread-qa-lab
corepack pnpm --filter @t3tools/lab-ios... --filter @t3tools/web... install --frozen-lockfile --ignore-scripts
cd apps/lab-ios
PORT=19873 node ../../node_modules/vite-plus/bin/vp dev
```

In a second terminal, from the QA checkout, use Chrome and Python 3.12. Choose an evidence directory outside build products. The tracked [report.json](report.json) contains the exact title, full Markdown body and assistant reply. The harness loads that file by default. Supply the same strings to the native seed. The report must arrive via the server-created delegated completion on the parent thread, followed by the assistant reply.

```sh
cd apps/ios/scripts/thread-qa
export EVIDENCE="$(mktemp -d)"
python3.12 -m venv /tmp/conn-thread-check
. /tmp/conn-thread-check/bin/activate
pip install pillow==13.0.0 tesserocr==2.13.0 playwright==1.58.0
mkdir -p /tmp/conn-thread-data
curl -fsSL https://raw.githubusercontent.com/tesseract-ocr/tessdata_fast/main/eng.traineddata \
  -o /tmp/conn-thread-data/eng.traineddata
echo '7d4322bd2a7749724879683fc3912cb542f19906c83bcc1a52132556427170b2  /tmp/conn-thread-data/eng.traineddata' | shasum -a 256 -c -
python lab.py "$EVIDENCE/lab" --origin http://127.0.0.1:19873 --tessdata /tmp/conn-thread-data
```

The runner prints computed font size and line height on the painted reply and bubble, then evaluates the screenshots with OCR and pixel checks. Both references must pass at 16 px / 24 px. The old-size mutations must reach 13 px / 21.125 px and fail the wrap check. The other seven mutations must fail their named checks for an outgoing bubble, extra status row, wrong inner fill, hidden attachment, smaller card preview, tight composer inset and covered timestamp.

1. On native, open the seeded thread, dismiss the keyboard and go to the newest message. Save `native-closed.png` after scrolling stops.
2. Focus the empty composer, show the English QWERTY software keyboard with predictive text, and go to the newest message. Save `native-focused.png` after the keyboard stops. Record the keyboard's actual top in screen points from the accessibility frame. With only a screenshot, multiply the top edge's pixel Y by 402 and divide by the full image width. Round to the nearest point.
3. To reproduce the focused lab geometry, pass the same `--keyboard-top "$KEYBOARD_TOP_PT"` to `lab.py`. Its extra reference reserves the measured keyboard space and the native 2 pt gutter. The iOS keyboard itself appears only in the native capture.
4. Run both checks. Each exits nonzero for a mismatch. Retain both images and the output alongside the build SHA, device bounds and text settings. The focused check uses the measured keyboard top and requires visible keyboard keys, the attachment plus, the final four-line reply and its timestamp above the composer.

```sh
python check.py "$EVIDENCE/native-closed.png" --tessdata /tmp/conn-thread-data
python check.py "$EVIDENCE/native-focused.png" --tessdata /tmp/conn-thread-data \
  --keyboard-top "$KEYBOARD_TOP_PT"
```

For the user bubble, send the exact `reply` field in `report.json` as a normal user message and capture it fully visible with the keyboard down. Run `python check.py "$EVIDENCE/native-bubble.png" --bubble --tessdata /tmp/conn-thread-data`. At 402 pt wide and default Dynamic Type, the 16 pt body has 24 pt line spacing. This sentence wraps to five lines in the bubble and four in the assistant reply. The test checks painted glyph height, line breaks, inset and line spacing for each role.

If OCR reports a missing line, inspect the original PNG. The check measures visible text and pixels. Use the native interaction test to verify that tapping the disclosure or attachment opens it.

## Original 13 pt baseline from November 25

| Measurement | Lab, matched delegated content | Physical baseline, keyboard dismissed |
| --- | --- | --- |
| Page | `#161a1e` | `#161a1e` |
| Agent card | `#23272a`, x 16–386, width 370 pt | Single right-aligned `#394048` bubble, x 203–888 in the 921 px source, about 74% of screen width |
| Inner panel | `#303437`, x 19–383, width 364 pt | No separate agent panel. The dark table inside the report is report content. |
| Effective type | 13 CSS px, 21.125 px line height. The first preview line has 12 pt of ink. The first reply line ends at “delayed”. | At a common 402-wide display scale, paragraph ink is about 10 units high, with a 17.3-unit line pitch. The first reply line ends at “report”. |
| Composer | x 12, y 790, 378 × 48 pt. Visible plus in a 44 × 44 pt control. The final timestamp ends at y 769. | Centerline fill begins at y 1824 px. “Ask anything” starts at about x 26 on a 402-wide view. The leading plus is absent. |

The original browser JPEG shows the **greeting** thread. Its stored outer and inner fills are `#23272a` and `#303437`. A fresh full-phone capture of that route (`?screen=thread&thread=greeting&theme=dark-ocean&scale=1`) has the same two fills. The matched report reference uses this same lab card with the physical report's content.

Both physical PNGs are 921 × 2000. Their original logical device bounds, text-size settings and scroll offsets are unavailable. Width-normalized physical measurements are descriptive. The focused PNG shows a different passage. At its centerline the composer occupies y 1161–1269 px, the keyboard begins at y 1274 px (about 556 on a 402-wide view), and reply text is visible through the composer. The plus is absent in both states. Use the final two captures of the same seeded report to verify occlusion with the keyboard shown and dismissed.
