import { getFontEmbedCSS, toJpeg } from "html-to-image";
import { hostCapture } from "./hooks";
import { ANNOTATION_HOST_ID } from "./host";
import type { AnnotationDraft, AnnotationRect } from "./types";
import { screenshotCrop } from "./viewport";

const HIGHLIGHT = "#F53003";

type Scroll = { x: number; y: number };

/** Fonts rarely change on a page; embedding them is the slowest part of a DOM render. */
let fontCss: { key: number; css: Promise<string> } | undefined;

export async function captureAnnotationScreenshot(
  draft: AnnotationDraft,
  /** Page scroll when the box was measured; the page may have scrolled since. */
  scroll: Scroll = { x: window.scrollX, y: window.scrollY },
): Promise<string | undefined> {
  if (typeof document === "undefined" || !draft.boundingBox) {
    return undefined;
  }

  const crop = screenshotCrop(draft.boundingBox, {
    viewportWidth: window.innerWidth,
    viewportHeight: window.innerHeight,
  });
  // Where the crop sits in the viewport now.
  const live: AnnotationRect = {
    ...crop,
    x: crop.x + scroll.x - window.scrollX,
    y: crop.y + scroll.y - window.scrollY,
  };

  // A DOM render now would block the page the host was asked to spare, so a failed host
  // capture leaves the annotation without a screenshot.
  const image = hostCapture() ? await captureWithHost(live) : await renderDom(crop, live, scroll);

  if (!image) {
    return undefined;
  }

  try {
    return await paintHighlight(image, crop, draft.boundingBox);
  } catch {
    return undefined;
  }
}

async function captureWithHost(rect: AnnotationRect): Promise<string | undefined> {
  const capture = hostCapture();

  if (!capture) {
    return undefined;
  }

  const host = document.getElementById(ANNOTATION_HOST_ID);
  if (host) hideOverlay(host);
  let active = true;
  let limit: number | undefined;
  const timeout = new Promise<undefined>((resolve) => {
    limit = window.setTimeout(() => resolve(undefined), OVERLAY_HIDE_LIMIT_MS);
  });
  const current = () => active && document.getElementById(ANNOTATION_HOST_ID) === host;
  const copy = async () => {
    await nextPaint();
    if (!current()) return undefined;
    const image = await capture(rect);
    return current() ? image : undefined;
  };
  let image: Blob | string | undefined;
  try {
    image = await Promise.race([copy(), timeout]);
  } catch {
    return undefined;
  } finally {
    active = false;
    window.clearTimeout(limit);
    if (host) revealOverlay(host);
  }
  if (!image) return undefined;
  try {
    return typeof image === "string" ? image : await blobToDataUrl(image);
  } catch {
    return undefined;
  }
}

const overlayHides = new WeakMap<HTMLElement, number>();
const OVERLAY_HIDE_LIMIT_MS = 1000;

// Opacity keeps the popup's textarea focused while the host copies the screen.
function hideOverlay(host: HTMLElement) {
  overlayHides.set(host, (overlayHides.get(host) ?? 0) + 1);
  host.style.opacity = "0";
}

function revealOverlay(host: HTMLElement) {
  const remaining = (overlayHides.get(host) ?? 1) - 1;
  if (remaining > 0) {
    overlayHides.set(host, remaining);
  } else {
    overlayHides.delete(host);
    host.style.removeProperty("opacity");
  }
}

/** Resolves once a frame with the latest DOM state has been composited. */
function nextPaint(): Promise<void> {
  return new Promise((resolve) => {
    window.requestAnimationFrame(() => window.requestAnimationFrame(() => resolve()));
  });
}

async function renderDom(
  crop: AnnotationRect,
  live: AnnotationRect,
  scroll: Scroll,
): Promise<string | undefined> {
  const filter = (node: HTMLElement) =>
    !(node instanceof Element) || (!shouldHideFromCapture(node) && mayAppearIn(node, live));

  try {
    return await toJpeg(document.documentElement, {
      quality: 0.72,
      pixelRatio: 1,
      width: crop.width,
      height: crop.height,
      canvasWidth: crop.width,
      canvasHeight: crop.height,
      // Let the browser cache serve images and fonts; a fresh fetch per capture is slow.
      cacheBust: false,
      fontEmbedCSS: await embeddedFonts(),
      filter,
      style: {
        transform: `translate(${-(scroll.x + crop.x)}px, ${-(scroll.y + crop.y)}px)`,
        transformOrigin: "top left",
      },
    });
  } catch {
    return undefined;
  }
}

function embeddedFonts(): Promise<string> {
  const key = document.styleSheets.length;

  if (!fontCss || fontCss.key !== key) {
    const css = getFontEmbedCSS(document.documentElement, { cacheBust: false });
    fontCss = { key, css };
    css.catch(() => {
      if (fontCss?.css === css) fontCss = undefined;
    });
  }

  return fontCss.css;
}

/**
 * Skip subtrees that cannot reach the crop, so the render clones and inlines styles for
 * a small part of a large page. A skipped node leaves the cloned layout, so only skip
 * nodes whose absence cannot move what is inside the crop: nodes below it, and nodes
 * out of the normal flow. Nodes above or beside the crop stay, since their size places it.
 */
function mayAppearIn(node: Element, crop: AnnotationRect): boolean {
  const box = node.getBoundingClientRect();

  if (box.width === 0 && box.height === 0) {
    // Empty boxes can still hold overflowing or positioned children.
    return true;
  }

  const intersects =
    box.right > crop.x &&
    box.left < crop.x + crop.width &&
    box.bottom > crop.y &&
    box.top < crop.y + crop.height;

  if (intersects) {
    return true;
  }

  if (box.top >= crop.y + crop.height) {
    return false;
  }

  const position = getComputedStyle(node).position;
  return position !== "absolute" && position !== "fixed";
}

export async function paintHighlight(
  image: string,
  crop: AnnotationRect,
  highlight: AnnotationRect,
  color = HIGHLIGHT,
): Promise<string> {
  const picture = await loadImage(image);
  // Host captures arrive in device pixels; keep them sharp and scale the box instead.
  const scale = picture.naturalWidth > 0 ? picture.naturalWidth / crop.width : 1;
  const canvas = document.createElement("canvas");
  canvas.width = Math.round(crop.width * scale);
  canvas.height = Math.round(crop.height * scale);

  const context = canvas.getContext("2d");

  if (!context) {
    return image;
  }

  context.drawImage(picture, 0, 0, canvas.width, canvas.height);
  context.scale(scale, scale);
  context.fillStyle = `${color}14`;
  context.strokeStyle = `${color}80`;
  context.lineWidth = 2;
  const left = highlight.x - crop.x;
  const top = highlight.y - crop.y;

  context.beginPath();

  if (typeof context.roundRect === "function") {
    context.roundRect(left, top, highlight.width, highlight.height, 4);
  } else {
    context.rect(left, top, highlight.width, highlight.height);
  }

  context.fill();
  context.stroke();

  return canvas.toDataURL("image/jpeg", 0.72);
}

function shouldHideFromCapture(node: Element): boolean {
  return Boolean(
    node.closest("#laravel-toolbar-shadow-host") || node.closest("#conn-annotation-host"),
  );
}

function blobToDataUrl(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(reader.error ?? new Error("Could not read capture."));
    reader.readAsDataURL(blob);
  });
}

function loadImage(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.onload = () => resolve(image);
    image.onerror = () => reject(new Error("Could not load annotation screenshot."));
    image.src = src;
  });
}
