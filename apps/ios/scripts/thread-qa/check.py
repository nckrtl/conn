"""Measure the Dark Ocean delegated-report fixture in a full, unscaled phone capture."""
import argparse
import re
from pathlib import Path

from PIL import Image, ImageOps
from tesserocr import PSM, RIL, PyTessBaseAPI, iterate_level

WIDTH, HEIGHT = 402, 874
PAGE, CARD, INSET = (22, 26, 30), (35, 39, 42), (48, 52, 55)


def recognize(image, tessdata, rect=None):
    with PyTessBaseAPI(path=str(tessdata), psm=PSM.SPARSE_TEXT) as api:
        api.SetImage(ImageOps.invert(image.convert("L").resize((WIDTH * 3, HEIGHT * 3))))
        if rect is not None:
            api.SetRectangle(*(value * 3 for value in rect))
        api.Recognize()
        lines = []
        iterator = api.GetIterator()
        for line in iterate_level(iterator, RIL.TEXTLINE):
            if not line.GetUTF8Text(RIL.TEXTLINE):
                continue
            text = line.GetUTF8Text(RIL.TEXTLINE).lower().strip()
            box = [v / 3 for v in line.BoundingBox(RIL.TEXTLINE)]
            lines.append((text, *box))
        return sorted(lines, key=lambda line: line[2])


def close_color(actual, expected):
    return max(abs(a - b) for a, b in zip(actual, expected)) <= 3


def surface(image, y, expected, left, right):
    # Ink interrupts a scanline. Require solid fill across most of the span,
    # plus the expected left AND right edges. A right-aligned bubble fails.
    hits = [x for x in range(WIDTH) if close_color(image.getpixel((x, y)), expected)]
    edges = (hits[0], hits[-1] + 1) if hits else (0, 0)
    print(f"  y={y} fill={expected} span={edges} coverage={len(hits)}")
    return (abs(edges[0] - left) <= 3 and abs(edges[1] - right) <= 3
            and len(hits) >= (right - left) * 0.65)


def plus_visible(image, center_y):
    # A plus has two bright crossing strokes and four dark corners. Restrict
    # the search to the leading composer action so a caret cannot satisfy it.
    gray = image.convert("L")
    for y in range(center_y - 9, center_y + 10):
        for x in range(25, 53):
            corners = [gray.getpixel((x + dx, y + dy)) for dx in (-4, 4) for dy in (-4, 4)]
            arms = [gray.getpixel((x + dx, y + dy)) for dx, dy in
                    ((0, 0), (-4, 0), (4, 0), (0, -4), (0, 4))]
            if min(arms) - max(corners) > 45:
                return True
    return False


# Line breaks observed in the 402 pt lab with the same report sentence as
# both a normal user message and a left-aligned assistant reply.
REPLY_LINES = (
    "build 5 is already merged and installed on polar.",
    "this delayed report covers the liquid glass",
    "update. the thread-list flicker and ordering fix is",
    "still in progress.",
)
BUBBLE_LINES = (
    "build 5 is already merged and",
    "installed on polar. this delayed",
    "report covers the liquid glass",
    "update. the thread-list flicker and",
    "ordering fix is still in progress.",
)


def body_lines(feed, expected, left, require):
    lines = []
    for words in expected:
        matches = [line for line in feed if line[0] == words]
        if len(matches) != 1:
            require(False, f"message body wrap differs at: {words}")
            return []
        lines.append(matches[0])
    require(all(13 <= b - y <= 17 for _, x, y, r, b in lines), "message body glyph height differs")
    require(all(abs(x - left) <= 4 for _, x, y, r, b in lines), "message body horizontal inset differs")
    require(all(abs(b[2] - a[2] - 24) <= 2 for a, b in zip(lines, lines[1:])),
            "message body line spacing differs")
    return lines


def check(path, tessdata, keyboard_top, bubble=False):
    errors = []

    def require(condition, message):
        if not condition:
            errors.append(message)

    with Image.open(path) as source:
        scale, remainder = divmod(source.width, WIDTH)
        require(not remainder and scale >= 1 and source.height == HEIGHT * scale,
                f"{source.size} is not a full integer-scale {WIDTH} × {HEIGHT} capture")
        if abs(source.width / source.height - WIDTH / HEIGHT) > 0.002:
            return errors + ["wrong aspect ratio"]
        source = source.convert("RGB")
    lines = recognize(source, tessdata)
    image = source.resize((WIDTH, HEIGHT), Image.Resampling.LANCZOS)
    titles = ("wireguard launch", "normal user bubble") if bubble else ("wireguard launch",)
    require(any(any(title in text for title in titles) and y < 100
                for text, x, y, r, b in lines), "wrong thread title")
    # The lab leaves 36 pt below the 48 pt composer. On iOS the focused
    # composer sits directly above the measured software keyboard.
    bottom = keyboard_top if keyboard_top is not None else HEIGHT - 36
    top = bottom - 48
    center = bottom - 24
    keyboard = any(re.search(r"\b123\b", t) and y > 690 for t, x, y, r, b in lines)
    require(keyboard == (keyboard_top is not None), "keyboard visibility does not match the capture")
    require(plus_visible(image, center), f"missing attachment plus near composer y={center}")
    if not keyboard:
        # OCR can combine the plus and placeholder into one string. Crop out
        # the button so the measured x is always the first glyph of "Ask".
        field = recognize(source, tessdata, rect=(55, center - 20, 200, 40))
        require(any("ask anything" in t and abs(x - 73) <= 4 and abs(y - center) < 14
                    for t, x, y, r, b in field), "empty composer placeholder missing or misplaced")

    feed = [line for line in lines if 104 < line[2] and line[4] <= top]
    if bubble:
        body_lines(feed, BUBBLE_LINES, 107, require)
        return errors

    # This fixture contains exactly one completed delegate report, followed
    # by one assistant reply. There is no user-authored outgoing message.
    pixels = image.load()
    bubble_rows = [y for y in range(112, top)
                   if close_color(pixels[60, y], PAGE)
                   and all(close_color(pixels[x, y], (57, 64, 72)) for x in (95, 180, 270, 375))]
    if len(bubble_rows) > 30:
        middle = bubble_rows[len(bubble_rows) // 2]
        xs = [x for x in range(WIDTH) if close_color(pixels[x, middle], (57, 64, 72))]
        errors.append(f"generic outgoing fill at y={middle}, span=({min(xs)}, {max(xs) + 1})")

    def one_line(fragment):
        matches = [line for line in feed if fragment in line[0]]
        require(len(matches) == 1, f"missing unique visible line: {fragment}")
        return matches[0] if len(matches) == 1 else None

    header = one_line("agent")
    title = one_line("use native liquid glass for iphone floating controls")
    preview = one_line("build 5 is ready for host signing and in-place install")
    if header:
        require(surface(image, round((header[2] + header[4]) / 2), CARD, 16, 386),
                "outer card fill or width")
    if title and preview and header:
        require(header[4] < title[2] < title[4] < preview[2], "Agent header and disclosure order")
        require(abs(preview[2] - header[2] - 66) <= 5, "extra space or row in collapsed Agent card")
    if preview:
        _, x, y, right, base = preview
        print(f"  report preview: x={x:.1f} width={right - x:.1f} ink-height={base - y:.1f}")
        require(abs(x - 30) <= 4 and 10 <= base - y <= 15 and 295 <= right - x <= 325,
                "preview type or inset differs")
        require(surface(image, round(y - 3), INSET, 19, 383), "inner card fill or width")
        require(close_color(image.getpixel((6, round(y))), PAGE), "Dark Ocean page fill")

    reply = body_lines(feed, REPLY_LINES, 17, require)
    if reply:
        first, last = reply[0], reply[-1]
        if preview:
            require(preview[4] < first[2], "reply must follow the report")
        times = [l for l in feed if l[2] > last[4] and re.search(r"\b\d{1,2}:\d{2}\b", l[0])]
        require(times, f"last reply timestamp covered by composer (top≈{top} pt)")
        if times:
            gap = top - times[-1][4]
            print(f"  visible time to composer: {gap:.1f} pt")
            require(2 <= gap <= 48, "tail is not settled above the composer")
    return errors


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("image", type=Path)
    parser.add_argument("--tessdata", type=Path, required=True, help="directory containing eng.traineddata")
    parser.add_argument("--keyboard-top", type=int, help="observed focused keyboard minY in screen points")
    parser.add_argument("--bubble", action="store_true", help="measure report.json reply as a normal user bubble")
    args = parser.parse_args()
    if args.keyboard_top is not None and not 400 <= args.keyboard_top <= 650:
        parser.error("expected a portrait software keyboard top between 400 and 650 pt")
    failures = check(args.image, args.tessdata, args.keyboard_top, args.bubble)
    for failure in failures:
        print(f"FAIL {failure}")
    print("FAIL" if failures else "PASS", args.image)
    raise SystemExit(bool(failures))
