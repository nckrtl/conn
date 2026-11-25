"""Capture the running lab and exercise the screenshot checker with visual mutations."""
import argparse
import json
from pathlib import Path
from urllib.parse import urlencode

from playwright.sync_api import sync_playwright

from check import HEIGHT, check

parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument("out", type=Path)
parser.add_argument("report", type=Path, help="JSON with title, body and reply from the native seed")
parser.add_argument("--origin", default="http://127.0.0.1:5801")
parser.add_argument("--tessdata", type=Path, required=True)
parser.add_argument("--keyboard-top", type=int, help="also capture lab layout at the native keyboard top")
args = parser.parse_args()
if args.keyboard_top is not None and not 400 <= args.keyboard_top <= 650:
    parser.error("expected a portrait software keyboard top between 400 and 650 pt")
args.out.mkdir(parents=True, exist_ok=True)
data = json.loads(args.report.read_text())
fixture = {
    "key": "delegate-qa", "title": "Conn iOS WireGuard Launch Experience", "project": "apps",
    "instanceId": "codex", "model": "GPT-6.2 Astra", "minutesAgo": 0,
    "entries": [
        {"kind": "agentMessage", "from": data["title"], "text": data["body"], "minutesAgo": 1},
        {"kind": "assistant", "text": data["reply"], "minutesAgo": 0},
    ],
}
query = urlencode(dict(screen="thread", thread=fixture["key"], theme="dark-ocean", scale=1))
with sync_playwright() as playwright:
    browser = playwright.chromium.launch(channel="chrome")
    page = browser.new_page(viewport={"width": 1000, "height": 1100}, device_scale_factor=3)
    stored = json.dumps(json.dumps([fixture]))
    page.add_init_script(f"localStorage.setItem('conn.ios-lab.threads.v1', {stored});")
    page.goto(f"{args.origin.rstrip('/')}/?{query}")
    phone = page.get_by_test_id("phone-dark-ocean")
    phone.get_by_text(data["reply"], exact=True).wait_for()
    page.evaluate("document.fonts.ready")
    feed = phone.locator(".m-feed")
    cases = [
        ("reference", "/* unmodified lab */", None),
        ("outgoing", """.m-agent-message {
            width: 80%; align-self: flex-end; background: #394048 !important;
        } .m-agent-message .m-feed-card-content {background: transparent !important}""",
         "generic outgoing fill"),
        ("wrong-inset", ".m-agent-message .m-feed-card-content {background: #394048 !important}",
         "inner card fill or width"),
        ("hidden-attachment", ".m-composer-plus {visibility: hidden}", "missing attachment plus"),
        ("small-type", ".m-feed .m-feed-card-preview {font-size: 10px !important}",
         "preview type or inset"),
        ("old-body-size", ".m-feed-text .m-md {font-size: 13px !important; line-height: 21.125px !important}",
         "message body wrap differs"),
        ("covered-tail", ".m-feed-item:last-child .ios-message-meta {visibility: hidden}",
         "last reply timestamp covered"),
    ]
    for name, css, expected in cases:
        style = page.add_style_tag(content=css)
        feed.evaluate("n => n.scrollTop = n.scrollHeight")
        image = args.out / f"{name}.png"
        phone.screenshot(path=image, animations="disabled")
        errors = check(image, args.tessdata, None)
        print(f"{name}: {errors or 'PASS'}")
        if (expected is None and errors) or (expected and not any(expected in e for e in errors)):
            raise SystemExit(f"unexpected result for {name}")
        style.evaluate("n => n.remove()")
    if args.keyboard_top is not None:
        # Reserve the measured keyboard space plus the native 2 pt gutter.
        # The lab has no iOS keyboard. This image is a layout reference only.
        phone.locator(".m-thread-bottom").evaluate(
            "(node, pad) => node.style.paddingBottom = pad + 'px'", HEIGHT - args.keyboard_top + 2
        )
        feed.evaluate("n => n.scrollTop = n.scrollHeight")
        phone.screenshot(path=args.out / "keyboard-space-reference.png", animations="disabled")
    fixture["entries"] = [{"kind": "user", "text": data["reply"], "minutesAgo": 0}]
    bubble_page = browser.new_page(viewport={"width": 1000, "height": 1100}, device_scale_factor=3)
    stored = json.dumps(json.dumps([fixture]))
    bubble_page.add_init_script(f"localStorage.setItem('conn.ios-lab.threads.v1', {stored});")
    bubble_page.goto(f"{args.origin.rstrip('/')}/?{query}")
    bubble_phone = bubble_page.get_by_test_id("phone-dark-ocean")
    bubble_phone.locator(".m-user-bubble").get_by_text(data["reply"], exact=True).wait_for()
    bubble_page.evaluate("document.fonts.ready")
    for name, css in (("bubble", None), ("old-bubble-size", "font-size: 13px; line-height: 21.125px")):
        if css:
            bubble_phone.locator(".m-user-bubble").evaluate("(el, css) => el.style.cssText += css", css)
        bubble_phone.locator(".m-feed").evaluate("n => n.scrollTop = n.scrollHeight")
        image = args.out / f"{name}.png"
        bubble_phone.screenshot(path=image, animations="disabled")
        errors = check(image, args.tessdata, None, bubble=True)
        print(f"{name}: {errors or 'PASS'}")
        if (not css and errors) or (css and not any("message body wrap differs" in e for e in errors)):
            raise SystemExit(f"unexpected result for {name}")
    browser.close()
