import "../index.css";

import { describe, expect, it, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";

import { render } from "../../test/render";
import { useCommitOnBlur } from "../hooks/useCommitOnBlur";
import { AppRouteModal } from "./AppRouteModal";

function CommitOnBlurField({ onCommit }: { onCommit: (next: string) => void }) {
  return <input aria-label="Instructions" {...useCommitOnBlur("", onCommit)} />;
}

/** The alpha of a computed color, whatever color syntax the browser serializes it in. */
function alphaOf(color: string): number {
  const canvas = document.createElement("canvas");
  canvas.width = 1;
  canvas.height = 1;
  const context = canvas.getContext("2d");
  if (!context) throw new Error("no 2d context");
  context.fillStyle = color;
  context.fillRect(0, 0, 1, 1);
  return (context.getImageData(0, 0, 1, 1).data[3] ?? 0) / 255;
}

/** The root classes of the macOS desktop app, removed again when the test ends. */
function macDesktopRoot(dark: boolean): Disposable {
  const classes = dark ? ["electron-macos", "dark"] : ["electron-macos"];
  document.documentElement.classList.add(...classes);
  return { [Symbol.dispose]: () => document.documentElement.classList.remove(...classes) };
}

describe("AppRouteModal", () => {
  it("commits a focused field when Esc closes it", async () => {
    const onCommit = vi.fn();
    await using _screen = await render(
      <AppRouteModal label="Settings">
        <CommitOnBlurField onCommit={onCommit} />
      </AppRouteModal>,
      { router: "/settings/general" },
    );

    await page.getByRole("textbox", { name: "Instructions" }).fill("Keep titles short");
    await userEvent.keyboard("{Escape}");

    expect(onCommit).toHaveBeenCalledWith("Keep titles short");
  });

  // The macOS window glass thins the window frame (--shell-fill) to 60%. The modal floats over
  // the app, so a bright browser page behind it must not tint its shell, and its backdrop must
  // calm that page like the rest of the window.
  it.each([false, true])(
    "keeps the shell nearly opaque over the macOS glass (dark: %s)",
    async (dark) => {
      using _root = macDesktopRoot(dark);
      await using _screen = await render(<AppRouteModal label="Orbit">content</AppRouteModal>, {
        router: "/settings/general",
      });

      const popup = document.querySelector<HTMLElement>("[data-app-modal]");
      const backdrop = document.querySelector<HTMLElement>('[data-slot="dialog-backdrop"]');
      expect(popup).not.toBeNull();
      expect(backdrop).not.toBeNull();

      const shell = getComputedStyle(popup!);
      expect(alphaOf(shell.backgroundColor)).toBeGreaterThanOrEqual(0.9);
      // The frame's own blur stays as it was.
      expect(shell.backdropFilter).toContain("blur(40px)");

      expect(backdrop!.classList).toContain("app-modal-backdrop");
      const behind = getComputedStyle(backdrop!);
      expect(alphaOf(behind.backgroundColor)).toBeGreaterThanOrEqual(0.75);
      expect(behind.backdropFilter).toMatch(/blur\(1[26]px\)/);
    },
  );
});
