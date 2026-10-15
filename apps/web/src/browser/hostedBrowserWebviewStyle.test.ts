import { describe, expect, it } from "vite-plus/test";

import {
  HIDDEN_BROWSER_WEBVIEW_OFFSET,
  resolveHostedBrowserWebviewWrapperStyle,
} from "./hostedBrowserWebviewStyle";

describe("resolveHostedBrowserWebviewWrapperStyle", () => {
  it("places an active webview on its presented surface", () => {
    expect(
      resolveHostedBrowserWebviewWrapperStyle({
        active: true,
        renderingActive: true,
        rect: { x: 12, y: 34, width: 800, height: 600 },
        hiddenSize: { width: 1280, height: 800 },
      }),
    ).toEqual({
      left: 12,
      top: 34,
      width: 800,
      height: 600,
      zIndex: 30,
      pointerEvents: "auto",
    });
  });

  it("clips a floating webview to the mini-player frame", () => {
    expect(
      resolveHostedBrowserWebviewWrapperStyle({
        active: true,
        renderingActive: true,
        cornerRadius: 12,
        zIndex: 48,
        rect: { x: 12, y: 34, width: 360, height: 203 },
        hiddenSize: { width: 1280, height: 800 },
      }),
    ).toMatchObject({
      left: 12,
      top: 34,
      width: 360,
      height: 203,
      borderRadius: 12,
      zIndex: 48,
    });
  });

  it("suspends painting for an inactive webview", () => {
    const style = resolveHostedBrowserWebviewWrapperStyle({
      active: false,
      renderingActive: false,
      rect: { x: 12, y: 34, width: 800, height: 600 },
      hiddenSize: { width: 393, height: 852 },
    });

    expect(style).toEqual({
      left: HIDDEN_BROWSER_WEBVIEW_OFFSET,
      top: HIDDEN_BROWSER_WEBVIEW_OFFSET,
      width: 393,
      height: 852,
      zIndex: -1,
      pointerEvents: "none",
      opacity: 0,
      visibility: "hidden",
    });
  });

  it("keeps a background guest captureable without exposing it through the shell", () => {
    const style = resolveHostedBrowserWebviewWrapperStyle({
      active: false,
      renderingActive: true,
      rect: null,
      hiddenSize: { width: 1280, height: 800 },
    });

    expect(style).toEqual({
      left: 0,
      top: 0,
      width: 1280,
      height: 800,
      zIndex: -1,
      pointerEvents: "none",
      opacity: 0,
      visibility: "visible",
    });
  });

  it("keeps an inactive webview paintable without marking it as rendering-active", () => {
    const style = resolveHostedBrowserWebviewWrapperStyle({
      active: false,
      renderingActive: false,
      keepPaintableWhenInactive: true,
      rect: null,
      hiddenSize: { width: 1280, height: 800 },
    });

    expect(style).toEqual({
      left: HIDDEN_BROWSER_WEBVIEW_OFFSET,
      top: HIDDEN_BROWSER_WEBVIEW_OFFSET,
      width: 1280,
      height: 800,
      zIndex: -1,
      pointerEvents: "none",
      opacity: 0,
      visibility: "visible",
    });
  });
  it("restores the same guest when a background tab is presented again", () => {
    const input = {
      renderingActive: true,
      rect: { x: 640, y: 92, width: 456, height: 684 },
      hiddenSize: { width: 456, height: 684 },
    };
    const shown = resolveHostedBrowserWebviewWrapperStyle({ ...input, active: true });
    const parked = resolveHostedBrowserWebviewWrapperStyle({ ...input, active: false });
    const restored = resolveHostedBrowserWebviewWrapperStyle({ ...input, active: true });
    expect(parked.opacity).toBe(0);
    expect(parked.visibility).toBe("visible");
    expect([parked.width, parked.height]).toEqual([shown.width, shown.height]);
    expect(restored).toEqual(shown);
    expect(restored.opacity).toBeUndefined();
    expect(restored.pointerEvents).toBe("auto");
  });
});
