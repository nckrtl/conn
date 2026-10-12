import type { ComponentProps } from "react";

import { cn } from "~/lib/utils";

/** One glass backdrop until a top attachment needs the composer to cover its overlap. */
function Shell({
  contextStrip = false,
  className,
  ...props
}: ComponentProps<"div"> & { contextStrip?: boolean }) {
  return (
    <div
      data-slot="composer-shell"
      data-with-context={contextStrip || undefined}
      className={cn(
        "@container/composer-surface group/composer-surface relative isolate mx-auto w-full max-w-(--chat-content-max-width)",
        "[--chat-composer-drawer-inset:1.375rem] [--chat-composer-glass-surface:var(--card)] [--chat-composer-outline:rgb(0_0_0/8%)]",
        "dark:[--chat-composer-glass-surface:var(--surface-raised)] dark:[--chat-composer-outline:color-mix(in_srgb,var(--color-white)_5%,transparent)]",
        "[html[data-theme-id]_&]:[--chat-composer-glass-surface:var(--app-theme-surface-raised)] [html[data-theme-id]_&]:[--chat-composer-outline:var(--app-theme-toolbar-border)]",
        "dark:[html[data-theme-id]:not([data-theme-id=t3-chat])_&]:[--chat-composer-outline:color-mix(in_srgb,var(--app-theme-input)_30%,var(--background))]",
        "dark:[html[data-theme-id=t3-chat]_&]:[--chat-composer-outline:#241e28]",
        "before:pointer-events-none before:absolute before:inset-0 before:z-0 before:rounded-3xl before:bg-(--chat-composer-glass-surface)/(--glass-opacity) before:backdrop-blur-(--glass-blur) before:backdrop-saturate-(--glass-saturation)",
        "not-supports-[((backdrop-filter:blur(1px))_or_(-webkit-backdrop-filter:blur(1px)))]:before:bg-(--chat-composer-glass-surface)",
        // Dark: the raised shell surface, a step lighter than the chat card.
        // The fill is opaque, so a backdrop filter would only re-blur the timeline on every scroll.
        "dark:before:bg-(--shell-raised) dark:before:backdrop-filter-none",
        // Dark: banners and the context strip show the raised surface through, a step darker.
        "dark:[--chat-composer-drawer-surface:color-mix(in_oklab,var(--shell-raised)_60%,transparent)]",
        "has-data-[composer-banner-surface=attached]:before:hidden data-model-strip-transition:before:hidden",
        contextStrip && [
          "[--chat-composer-context-extension:2.25rem] sm:[--chat-composer-context-extension:2rem]",
          // Keep one continuous backdrop around the fixed-pixel corners and rem-sized strip inset.
          "supports-[clip-path:shape(from_0_0,line_to_1px_1px)]:before:rounded-none",
          "before:[clip-path:shape(from_0_22px,curve_to_22px_0_with_0_9.85px/9.85px_0,line_to_calc(100%-22px)_0,curve_to_100%_22px_with_calc(100%-9.85px)_0/100%_9.85px,line_to_100%_calc(100%-var(--chat-composer-context-extension)-var(--chat-composer-drawer-inset)),curve_to_calc(100%-var(--chat-composer-drawer-inset))_calc(100%-var(--chat-composer-context-extension))_with_100%_calc(100%-var(--chat-composer-context-extension)-var(--chat-composer-drawer-inset)*0.4477)/calc(100%-var(--chat-composer-drawer-inset)*0.4477)_calc(100%-var(--chat-composer-context-extension)),line_to_calc(100%-var(--chat-composer-drawer-inset))_calc(100%-16px),curve_to_calc(100%-var(--chat-composer-drawer-inset)-16px)_100%_with_calc(100%-var(--chat-composer-drawer-inset))_calc(100%-7.16px)/calc(100%-var(--chat-composer-drawer-inset)-7.16px)_100%,line_to_calc(var(--chat-composer-drawer-inset)+16px)_100%,curve_to_var(--chat-composer-drawer-inset)_calc(100%-16px)_with_calc(var(--chat-composer-drawer-inset)+7.16px)_100%/var(--chat-composer-drawer-inset)_calc(100%-7.16px),line_to_var(--chat-composer-drawer-inset)_calc(100%-var(--chat-composer-context-extension)),curve_to_0_calc(100%-var(--chat-composer-context-extension)-var(--chat-composer-drawer-inset))_with_calc(var(--chat-composer-drawer-inset)*0.4477)_calc(100%-var(--chat-composer-context-extension))/0_calc(100%-var(--chat-composer-context-extension)-var(--chat-composer-drawer-inset)*0.4477),line_to_0_22px,close)]",
          "not-supports-[clip-path:shape(from_0_0,line_to_1px_1px)]:before:bottom-(--chat-composer-context-extension)",
          // Dark: the strip is translucent, so the Host paints the opaque raised fill itself.
          // A fixed-extent backdrop here would stop short when the strip is a different height.
          "dark:before:hidden",
        ],
        // The collapse tween paints the card through TweenGhost instead (dark only).
        "data-[composer-tween=true]:before:hidden",
        className,
      )}
      {...props}
    />
  );
}

const outlineClasses =
  "after:pointer-events-none after:absolute after:inset-0 after:rounded-[inherit] after:border after:border-(--chat-composer-outline) dark:after:border-white/7 dark:after:border-t-white/10";

// The bottom strip continues the outline, so leave the seam between its corners open.
// Dark shares one surface color with the strip, so it keeps the seam as a separator.
const contextSeamClasses =
  "group-data-with-context/composer-surface:after:[clip-path:polygon(0_0,100%_0,100%_100%,calc(100%-22px)_100%,calc(100%-22px)_calc(100%-2px),22px_calc(100%-2px),22px_100%,0_100%)] dark:group-data-with-context/composer-surface:after:[clip-path:none]";

/**
 * The ghost's static bottom band: one corner radius (the `rounded-3xl` radius)
 * plus a pixel. The moving layer is clipped above it, so both ends of a card as
 * short as two radii still show their rounded corners.
 */
const GHOST_CAP = "calc(var(--radius) + 13px)";

/**
 * Stand-in for the card's fill and outline while the composer collapses or
 * expands in a dark theme. The real box commits its final height at once, so
 * resizing it would repaint on every frame. The ghost instead paints a card
 * that is as tall as the larger of the old and new heights: a layer whose top
 * edge slides by `transform` behind a static clip window, and a static cap that
 * carries the bottom corners and outline. The composer hook sizes the layer,
 * animates it, and sets `data-composer-tween` on the shell, which hides the
 * painters this replaces. Only opaque dark fills qualify; glass needs the real
 * backdrop.
 */
function TweenGhost() {
  return (
    <div
      aria-hidden
      className="pointer-events-none absolute inset-0 -z-1 hidden group-data-[composer-tween=true]/composer-surface:block"
    >
      <div
        data-composer-tween-window
        className="absolute inset-x-0 overflow-clip"
        style={{ bottom: GHOST_CAP }}
      >
        <div
          data-composer-tween-layer
          className="absolute inset-x-0 rounded-3xl border border-white/7 border-t-white/10 bg-(--shell-raised)"
          style={{ bottom: `calc(-1 * ${GHOST_CAP})` }}
        />
      </div>
      <div
        className="absolute inset-x-0 bottom-0 rounded-b-3xl border border-t-0 border-white/7 bg-(--shell-raised)"
        style={{ height: "calc(var(--radius) + 14px)" }}
      />
    </div>
  );
}

function Host({ className, children, ...props }: ComponentProps<"div">) {
  return (
    <div
      data-slot="composer-host"
      className={cn(
        "relative z-10 w-full rounded-3xl shadow-composer after:z-1 dark:shadow-none",
        // During the collapse tween TweenGhost paints the fill and outline.
        "group-data-[composer-tween=true]/composer-surface:bg-transparent! group-data-[composer-tween=true]/composer-surface:after:hidden",
        // Dark with a strip: the composer fill follows the Host box, whatever the strip height.
        // With an attached banner, Main paints the fill instead.
        "dark:group-data-with-context/composer-surface:not-group-has-data-[composer-banner-surface=attached]/composer-surface:bg-(--shell-raised)",
        outlineClasses,
        contextSeamClasses,
        "group-has-data-[composer-banner-surface=attached]/composer-surface:shadow-none group-has-data-[composer-banner-surface=attached]/composer-surface:after:hidden",
        className,
      )}
      {...props}
    >
      <TweenGhost />
      {children}
    </div>
  );
}

function Main({ className, ...props }: ComponentProps<"div">) {
  return (
    <div
      data-chat-composer-main-surface="true"
      className={cn(
        "group relative z-10 rounded-3xl p-px",
        // The host also wraps shoulder tabs, so its backdrop would extend above the input.
        "group-data-model-strip-transition/composer-surface:bg-(--chat-composer-glass-surface)/(--glass-opacity) group-data-model-strip-transition/composer-surface:backdrop-blur-(--glass-blur) group-data-model-strip-transition/composer-surface:backdrop-saturate-(--glass-saturation)",
        "dark:group-data-model-strip-transition/composer-surface:bg-(--shell-raised) dark:group-data-model-strip-transition/composer-surface:backdrop-filter-none",
        outlineClasses,
        contextSeamClasses,
        "after:z-20 after:hidden group-has-data-[composer-banner-surface=attached]/composer-surface:after:block",
        "group-has-data-[composer-banner-surface=attached]/composer-surface:bg-(--chat-composer-glass-surface)/(--glass-opacity) group-has-data-[composer-banner-surface=attached]/composer-surface:backdrop-blur-(--glass-blur) group-has-data-[composer-banner-surface=attached]/composer-surface:backdrop-saturate-(--glass-saturation)",
        "group-has-data-[composer-banner-surface=attached]/composer-surface:shadow-composer dark:group-has-data-[composer-banner-surface=attached]/composer-surface:shadow-none",
        "not-supports-[((backdrop-filter:blur(1px))_or_(-webkit-backdrop-filter:blur(1px)))]:group-has-data-[composer-banner-surface=attached]/composer-surface:bg-(--chat-composer-glass-surface)",
        // Dark: keep the raised shell surface the composer has without a banner.
        "dark:group-has-data-[composer-banner-surface=attached]/composer-surface:bg-(--shell-raised) dark:group-has-data-[composer-banner-surface=attached]/composer-surface:backdrop-filter-none",
        "group-has-data-[composer-banner-surface=attached]/composer-surface:**:data-[chat-composer-mobile-collapsed=true]:min-h-[calc(1rem+1px)]",
        className,
      )}
      {...props}
    />
  );
}

function ContextStrip({ className, ...props }: ComponentProps<"div">) {
  return (
    <div
      data-slot="composer-context-strip"
      className={cn(
        "group/composer-context relative isolate mx-auto -mt-4 flex w-[calc(100%-2*var(--chat-composer-drawer-inset))] items-center gap-2 overflow-x-clip overflow-y-visible px-2 pt-5 pb-1",
        "before:absolute before:inset-0 before:-z-1 before:rounded-b-2xl before:border before:border-(--chat-composer-outline) before:mask-b-from-transparent before:mask-b-from-4 before:mask-b-to-black before:mask-b-to-4 before:shadow-composer",
        // Dark: the Shell backdrop stops above the strip, so the strip blurs the page itself.
        "dark:before:border-white/7 dark:before:bg-(--chat-composer-drawer-surface) dark:before:backdrop-blur-(--glass-blur) dark:before:backdrop-saturate-(--glass-saturation) dark:before:shadow-composer-dark",
        "dark:group-has-data-[composer-banner-surface=attached]/composer-surface:before:bg-(--chat-composer-drawer-surface)",
        "group-has-data-[composer-banner-surface=attached]/composer-surface:before:bg-(--chat-composer-glass-surface)/(--glass-opacity) group-has-data-[composer-banner-surface=attached]/composer-surface:before:backdrop-blur-(--glass-blur) group-has-data-[composer-banner-surface=attached]/composer-surface:before:backdrop-saturate-(--glass-saturation)",
        "not-supports-[clip-path:shape(from_0_0,line_to_1px_1px)]:before:bg-(--chat-composer-glass-surface)/(--glass-opacity) not-supports-[clip-path:shape(from_0_0,line_to_1px_1px)]:before:backdrop-blur-(--glass-blur) not-supports-[clip-path:shape(from_0_0,line_to_1px_1px)]:before:backdrop-saturate-(--glass-saturation)",
        className,
      )}
      {...props}
    />
  );
}

export const ComposerSurface = { Shell, Host, Main, ContextStrip };
