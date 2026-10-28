import { observeResize } from "~/lib/observeResize";
import { shouldAnimateComposerRestingTransition } from "../composerFooterLayout";
import { useEffect, useLayoutEffect, useRef } from "react";

const COMPOSER_RESTING_TRANSITION_CLEANUP_BUFFER_MS = 50;
// One ease-in-out curve for every part of the collapse and the expansion: it
// picks up speed quickly and spends the last third settling.
const COMPOSER_RESTING_TRANSITION_EASING = "cubic-bezier(0.4, 0, 0.15, 1)";
const COMPOSER_RESTING_CONTROLS_DRIFT_PX = 6;

/**
 * Where an editor row's text sits, for sliding it between layouts.
 *
 * The expanded and resting layouts give the same prompt different line heights,
 * so its box top is not where its glyphs are: matching box tops leaves the text
 * a few pixels off at the first frame. The first text run is stable across both.
 * Rows without text fall back to the box.
 */
function composerTextTop(element: HTMLElement): number {
  const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT, {
    acceptNode: (node) =>
      node.textContent?.trim() ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_REJECT,
  });
  const text = walker.nextNode();
  if (!text) return element.getBoundingClientRect().top;
  const range = document.createRange();
  range.selectNodeContents(text);
  const rect = range.getBoundingClientRect();
  return rect.height > 0 ? rect.top : element.getBoundingClientRect().top;
}

/** The ghost painters inside the composer host that ComposerSurface renders. */
function findComposerTweenGhost(element: HTMLElement) {
  const host = element.closest<HTMLElement>('[data-slot="composer-host"]');
  return {
    host,
    shell: element.closest<HTMLElement>('[data-slot="composer-shell"]'),
    layer: host?.querySelector<HTMLElement>("[data-composer-tween-layer]") ?? null,
    window: host?.querySelector<HTMLElement>("[data-composer-tween-window]") ?? null,
  };
}

export function useComposerRestingTransition(
  isCollapsed: boolean,
  isResting: boolean,
  restingControlsRef: React.RefObject<HTMLDivElement | null>,
  onOverlayHeightChange: (height: number) => void,
  animationsActive: boolean,
  animationDurationMs: number,
  onControlsSettled: () => void,
) {
  const elementRef = useRef<HTMLDivElement>(null);
  const isCollapsedRef = useRef(isCollapsed);
  const previousCollapsedRef = useRef(isCollapsed);
  const previousRestingRef = useRef(isResting);
  const previousHeightRef = useRef<number | null>(null);
  const previousModelStripHeightRef = useRef<number | null>(null);
  const previousContentOffsetsRef = useRef<{
    promptFromTop: number | null;
    promptHeight: number | null;
    placeholderFromTop: number | null;
    actionFromBottom: number | null;
    controlsFromBottom: number | null;
    controlsFromLeft: number | null;
    surfaceBottomInset: number | null;
  }>({
    promptFromTop: null,
    promptHeight: null,
    placeholderFromTop: null,
    actionFromBottom: null,
    controlsFromBottom: null,
    controlsFromLeft: null,
    surfaceBottomInset: null,
  });
  const animationRef = useRef<Animation | null>(null);
  const animationTargetHeightRef = useRef<number | null>(null);
  const contentAnimationsRef = useRef<Animation[]>([]);
  const stateChangeAnimationsRef = useRef<Animation[]>([]);
  // Fades the footer controls out. It holds its end state until the next
  // transition, because React hides those controls only after the tween.
  const leavingControlsAnimationRef = useRef<Animation | null>(null);
  const pinnedOverlayRef = useRef<HTMLElement | null>(null);
  // True while the running tween paints the card through the ghost layer.
  const ghostActiveRef = useRef(false);
  const transitionCleanupTimeoutRef = useRef<number | null>(null);
  const transitionLayoutRequestRef = useRef(0);
  const hasCompletedInitialLayoutRef = useRef(false);
  // Border-box height of the body when the running tween last measured it, so
  // the body's resize notification for that same commit is not mistaken for a
  // change that needs a retarget.
  const animationBodyHeightRef = useRef<number | null>(null);

  const clearOverlayPin = () => {
    // The overlay belongs to the chat view and outlives this composer, so it
    // is remembered from pin time rather than re-resolved through a ref that
    // React may already have detached during unmount.
    const overlay = pinnedOverlayRef.current;
    pinnedOverlayRef.current = null;
    overlay?.style.removeProperty("height");
    overlay?.style.removeProperty("display");
    overlay?.style.removeProperty("flex-direction");
    overlay?.style.removeProperty("justify-content");
  };

  const clearTransitionStyles = () => {
    const element = elementRef.current;
    const footer = element?.querySelector<HTMLElement>('[data-chat-composer-footer="true"]');
    element?.style.removeProperty("overflow");
    element?.style.removeProperty("clip-path");
    element?.style.removeProperty("overflow-clip-margin");
    element
      ?.querySelector<HTMLElement>('[data-chat-composer-surface="true"]')
      ?.style.removeProperty("height");
    footer?.style.removeProperty("position");
    footer?.style.removeProperty("top");
    footer?.style.removeProperty("bottom");
    footer?.style.removeProperty("left");
    footer?.style.removeProperty("right");
    footer?.style.removeProperty("height");
    if (element) {
      const ghost = findComposerTweenGhost(element);
      ghost.shell?.removeAttribute("data-composer-tween");
      ghost.layer?.style.removeProperty("height");
      ghost.layer?.style.removeProperty("will-change");
      ghost.window?.style.removeProperty("top");
    }
    ghostActiveRef.current = false;
    const shell = element?.closest<HTMLElement>('[data-slot="composer-shell"]');
    shell?.removeAttribute("data-model-strip-transition");
    const modelStrip = shell?.querySelector<HTMLElement>('[data-composer-model-strip="true"]');
    for (const property of [
      "position",
      "top",
      "visibility",
      "height",
      "min-height",
      "padding-top",
      "align-items",
      "z-index",
      "pointer-events",
    ]) {
      modelStrip?.style.removeProperty(property);
    }
    clearOverlayPin();
  };

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- mirrors the collapsed flag into a ref read by ResizeObserver callbacks and running animations
  useLayoutEffect(() => {
    isCollapsedRef.current = isCollapsed;
  });

  const transitionToCurrentGeometry = (stateChanged: boolean) => {
    const element = elementRef.current;
    const surface = element?.querySelector<HTMLElement>('[data-chat-composer-surface="true"]');
    if (!element || !surface) return;

    const nextIsCollapsed = isCollapsedRef.current;

    const visibleTransitionElement = (selector: string) =>
      Array.from(element.querySelectorAll<HTMLElement>(selector)).find(
        (candidate) => candidate.getClientRects().length > 0,
      ) ?? null;
    const prompt = visibleTransitionElement(
      '[data-composer-prompt-surface="true"], [data-testid="composer-editor"], [data-chat-composer-transition-prompt="true"]',
    );
    const action = visibleTransitionElement('[data-chat-composer-transition-actions="true"]');
    const footer = element.querySelector<HTMLElement>('[data-chat-composer-footer="true"]');
    const continuousControls =
      element.dataset.inlineRestingControls === "true" || element.dataset.modelOnlyStrip === "true";
    const controls = nextIsCollapsed
      ? restingControlsRef.current
      : element.querySelector<HTMLElement>('[data-chat-composer-controls="left"]');
    // Present only for the tween of a collapse: the footer controls stay
    // mounted, inert, and fade out while the strip's copy fades in.
    const leavingControls = nextIsCollapsed
      ? element.querySelector<HTMLElement>('[data-chat-composer-controls-leaving="true"]')
      : null;

    const shell = element.closest<HTMLElement>('[data-slot="composer-shell"]');
    const modelStrip = shell?.querySelector<HTMLElement>('[data-composer-model-strip="true"]');
    const interruptedStripHeight =
      animationRef.current && modelStrip ? modelStrip.getBoundingClientRect().height : null;
    const interruptedAnimation = animationRef.current;
    const interruptedPromptTop = interruptedAnimation && prompt ? composerTextTop(prompt) : null;
    const interruptedActionTop = interruptedAnimation
      ? (action?.getBoundingClientRect().top ?? null)
      : null;
    const interruptedControlsLeft = interruptedAnimation
      ? (controls?.getBoundingClientRect().left ?? null)
      : null;
    const interruptedControlsTop = interruptedAnimation
      ? (controls?.getBoundingClientRect().top ?? null)
      : null;
    // The empty-prompt placeholder is a sibling overlay of the editor with
    // its own offset in each layout, so it slides on its own measurements.
    const placeholder = element.querySelector<HTMLElement>('[data-composer-placeholder="true"]');
    const interruptedPlaceholderTop =
      interruptedAnimation && placeholder ? composerTextTop(placeholder) : null;
    const ghost = findComposerTweenGhost(element);
    // A ghost tween leaves the real box at its final height, so the height
    // the user currently sees is the distance from the bottom edge to the
    // sliding layer's top.
    const interruptedHeight = interruptedAnimation
      ? ghostActiveRef.current && ghost.host && ghost.layer
        ? ghost.host.getBoundingClientRect().bottom - ghost.layer.getBoundingClientRect().top
        : element.getBoundingClientRect().height
      : null;
    // A retarget keeps the overlay held at the height the chat view last saw.
    const heldOverlayHeight = pinnedOverlayRef.current
      ? Number.parseFloat(pinnedOverlayRef.current.style.height)
      : Number.NaN;
    const interruptedTargetHeight = animationTargetHeightRef.current;
    const interruptedCurrentTime =
      typeof interruptedAnimation?.currentTime === "number"
        ? interruptedAnimation.currentTime
        : null;
    const interruptedDuration = interruptedAnimation?.effect?.getComputedTiming().duration;
    if (transitionCleanupTimeoutRef.current !== null) {
      window.clearTimeout(transitionCleanupTimeoutRef.current);
      transitionCleanupTimeoutRef.current = null;
    }
    interruptedAnimation?.cancel();
    animationRef.current = null;
    for (const animation of contentAnimationsRef.current) animation.cancel();
    contentAnimationsRef.current = [];
    if (stateChanged) {
      for (const animation of stateChangeAnimationsRef.current) animation.cancel();
      stateChangeAnimationsRef.current = [];
      leavingControlsAnimationRef.current?.cancel();
      leavingControlsAnimationRef.current = null;
    }
    clearTransitionStyles();

    const nextRect = element.getBoundingClientRect();
    const nextHeight = nextRect.height;
    const nextModelStripHeight = modelStrip?.getBoundingClientRect().height ?? null;
    // The chat view resize-observes the overlay to place the timeline
    // inset, the scroll-to-end pill, and the mini player. Pinning the
    // overlay at its destination height keeps that feedback to one update
    // instead of a ChatView re-render on every animation frame, and the
    // update itself waits for the tween to end: a re-render of the whole
    // chat view in the first frames of the tween is a visible stall. A
    // resting composer holds the timeline inset at its expanded height, so
    // nothing above the composer depends on the number in the meantime.
    const overlay = element.closest<HTMLElement>('[data-chat-composer-overlay="true"]');
    const overlayRect = overlay?.getBoundingClientRect();
    const overlayHeight = overlayRect?.height ?? null;
    const nextPromptRect = prompt?.getBoundingClientRect() ?? null;
    const nextPromptTop = prompt ? composerTextTop(prompt) : null;
    const nextActionTop = action?.getBoundingClientRect().top ?? null;
    const nextPlaceholderTop = placeholder ? composerTextTop(placeholder) : null;
    const nextControlsRect = controls?.getBoundingClientRect() ?? null;
    const nextControlsTop = nextControlsRect?.top ?? null;
    const footerBottom = footer ? nextRect.bottom - footer.getBoundingClientRect().bottom : 1;
    const previousHeight = interruptedHeight ?? previousHeightRef.current;
    const targetChanged =
      interruptedTargetHeight === null || Math.abs(interruptedTargetHeight - nextHeight) >= 0.5;
    const shouldAnimate = shouldAnimateComposerRestingTransition({
      hasCompletedInitialLayout: hasCompletedInitialLayoutRef.current,
      stateChanged,
      hasInterruptedAnimation: interruptedHeight !== null,
    });

    if (
      shouldAnimate &&
      animationsActive &&
      previousHeight !== null &&
      Math.abs(previousHeight - nextHeight) >= 0.5
    ) {
      const remainingDuration =
        typeof interruptedDuration === "number" && interruptedCurrentTime !== null
          ? Math.max(1, interruptedDuration - interruptedCurrentTime)
          : animationDurationMs;
      const duration =
        interruptedHeight !== null && !targetChanged ? remainingDuration : animationDurationMs;
      animationBodyHeightRef.current =
        element
          .querySelector<HTMLElement>('[data-chat-composer-body="true"]')
          ?.getBoundingClientRect().height ?? null;

      // Dark themes without an attached banner bridge the size change with a
      // transform on a ghost card (see ComposerSurface.TweenGhost). Light
      // glass, banner attachments, the model strip and controls that slide
      // inside the input need the real painters, so they keep the height
      // tween below.
      // The layer and the static cap each keep one corner radius of the card,
      // so a card shorter than two radii at either end falls back too.
      const ghostCapPx = ghost.layer
        ? Number.parseFloat(getComputedStyle(ghost.layer).borderTopLeftRadius) + 1
        : Number.NaN;
      const ghostParts =
        ghost.host &&
        ghost.shell &&
        ghost.layer &&
        ghost.window &&
        !modelStrip &&
        !continuousControls &&
        Number.isFinite(ghostCapPx) &&
        Math.min(previousHeight, nextHeight) >= 2 * ghostCapPx &&
        document.documentElement.classList.contains("dark") &&
        ghost.shell.querySelector('[data-composer-banner-surface="attached"]') === null
          ? { host: ghost.host, shell: ghost.shell, layer: ghost.layer, window: ghost.window }
          : null;
      // How far the card's top edge starts above (collapse) or below
      // (expansion) its final position.
      const deltaTop = previousHeight - nextHeight;

      // Pinning the overlay keeps the resize observer quiet for the tween.
      // The height tween pins the destination height and lets the surface
      // shrink inside it; the ghost tween commits the final layout at once,
      // so it pins the old height instead and the bottom-aligned content
      // sits at its final place within it. The pin lasts only for the tween
      // so later attachment, thread, font, and viewport changes remain
      // natural.
      if (overlay && overlayHeight !== null) {
        const pinnedHeight = ghostParts
          ? Number.isFinite(heldOverlayHeight)
            ? heldOverlayHeight
            : overlayHeight + deltaTop
          : overlayHeight;
        overlay.style.height = `${String(pinnedHeight)}px`;
        overlay.style.display = "flex";
        overlay.style.flexDirection = "column";
        overlay.style.justifyContent = "flex-end";
        pinnedOverlayRef.current = overlay;
      }

      let animation: Animation;
      let stripAnimation: Animation | null = null;
      if (ghostParts) {
        // The expanded footer controls fade out in place: stretch the
        // resting footer so they keep the row they had.
        if (footer && nextIsCollapsed && leavingControls) {
          footer.style.left = "1px";
          footer.style.right = "1px";
        }
        // The layer is as tall as the larger of the two heights, anchored to
        // the bottom edge. Its top starts at the old top and slides to the
        // new one; the window clips what hangs below the bottom cap.
        const extra = Math.max(0, deltaTop);
        ghostParts.shell.setAttribute("data-composer-tween", "true");
        ghostParts.window.style.top = `${String(-extra)}px`;
        ghostParts.layer.style.height = `${String(ghostParts.host.getBoundingClientRect().height + extra)}px`;
        ghostParts.layer.style.willChange = "transform";
        ghostActiveRef.current = true;
        animation = ghostParts.layer.animate(
          [
            { transform: `translateY(${String(extra - deltaTop)}px)` },
            { transform: `translateY(${String(extra)}px)` },
          ],
          { duration, easing: COMPOSER_RESTING_TRANSITION_EASING, fill: "forwards" },
        );
      } else {
        element.style.overflow = "clip";
        if (modelStrip) {
          const controlsClearance = Math.max(
            nextModelStripHeight ?? 0,
            previousModelStripHeightRef.current ?? 0,
          );
          element.style.overflowClipMargin = `${controlsClearance}px`;
          element.style.clipPath = `inset(0 0 -${controlsClearance}px 0)`;
        }
        surface.style.height = "100%";

        // Keep the footer attached to the stable bottom edge while the outer
        // height changes. Its resting absolute layout otherwise spans the old
        // height on collapse, while its expanded flow layout falls below the
        // clipped surface on expansion.
        if (footer) {
          footer.style.position = "absolute";
          footer.style.top = "auto";
          footer.style.bottom = `${String(footerBottom)}px`;
          footer.style.height = "3rem";
          if (nextIsCollapsed && !leavingControls) {
            footer.style.left = "auto";
            footer.style.right = "1px";
          } else {
            footer.style.left = "1px";
            footer.style.right = "1px";
          }
        }

        if (modelStrip) {
          const stripHeight = modelStrip.getBoundingClientRect().height;
          const stripOverlap = -Number.parseFloat(getComputedStyle(modelStrip).marginTop);
          const fromHeight =
            interruptedStripHeight ??
            (previousCollapsedRef.current
              ? (previousModelStripHeightRef.current ?? stripHeight)
              : stripOverlap);
          const toHeight = nextIsCollapsed ? stripHeight : stripOverlap;
          modelStrip.style.position = "relative";
          modelStrip.style.top = "auto";
          modelStrip.style.visibility = "visible";
          modelStrip.style.minHeight = "0";
          modelStrip.style.paddingTop = "0";
          modelStrip.style.alignItems = "flex-end";
          modelStrip.style.pointerEvents = "none";
          modelStrip.style.zIndex = "20";
          shell?.setAttribute("data-model-strip-transition", "true");
          stripAnimation = modelStrip.animate(
            [{ height: `${fromHeight}px` }, { height: `${toHeight}px` }],
            { duration, easing: COMPOSER_RESTING_TRANSITION_EASING, fill: "both" },
          );
        }

        animation = element.animate(
          [{ height: `${previousHeight}px` }, { height: `${nextHeight}px` }],
          { duration, easing: COMPOSER_RESTING_TRANSITION_EASING, fill: "both" },
        );
      }
      animationRef.current = animation;
      animationTargetHeightRef.current = nextHeight;

      // The box is bottom-anchored, so the old top sits `previousHeight`
      // above the old bottom edge whichever way the tween is drawn. The old
      // bottom moves only when the model strip below it changes height.
      const startRect = ghostParts ? nextRect : element.getBoundingClientRect();
      const previousBottom =
        overlayRect && previousContentOffsetsRef.current.surfaceBottomInset !== null
          ? overlayRect.bottom - previousContentOffsetsRef.current.surfaceBottomInset
          : startRect.bottom;
      const previousTop = previousBottom - previousHeight;
      const previousPromptTop =
        interruptedPromptTop ??
        (previousContentOffsetsRef.current.promptFromTop === null
          ? null
          : previousTop + previousContentOffsetsRef.current.promptFromTop);
      const previousActionTop =
        interruptedActionTop ??
        (previousContentOffsetsRef.current.actionFromBottom === null
          ? null
          : previousBottom - previousContentOffsetsRef.current.actionFromBottom);
      const contentAnimations: Animation[] = stripAnimation ? [stripAnimation] : [];
      const animateContentPosition = (
        content: HTMLElement | null,
        previousTop: number | null,
        measureTop?: (content: HTMLElement) => number,
        previousLeft: number | null = null,
      ): number => {
        if (!content || previousTop === null) return 0;
        // A default arrow parameter makes the React Compiler skip this component.
        const offset =
          previousTop - (measureTop ? measureTop(content) : content.getBoundingClientRect().top);
        const offsetX =
          previousLeft === null ? 0 : previousLeft - content.getBoundingClientRect().left;
        if (Math.abs(offset) < 0.5 && Math.abs(offsetX) < 0.5) return 0;
        contentAnimations.push(
          content.animate(
            [
              { transform: `translate(${String(offsetX)}px, ${String(offset)}px)` },
              { transform: "none" },
            ],
            {
              duration,
              easing: COMPOSER_RESTING_TRANSITION_EASING,
            },
          ),
        );
        return offset;
      };
      animateContentPosition(prompt, previousPromptTop, composerTextTop);
      animateContentPosition(
        placeholder,
        interruptedPlaceholderTop ??
          (previousContentOffsetsRef.current.placeholderFromTop === null
            ? null
            : previousTop + previousContentOffsetsRef.current.placeholderFromTop),
        composerTextTop,
      );
      const actionOffset = animateContentPosition(action, previousActionTop);
      if (continuousControls) {
        const previousControlsTop =
          interruptedControlsTop ??
          (previousContentOffsetsRef.current.controlsFromBottom === null
            ? null
            : previousBottom - previousContentOffsetsRef.current.controlsFromBottom);
        const previousControlsLeft =
          interruptedControlsLeft ??
          (previousContentOffsetsRef.current.controlsFromLeft === null
            ? null
            : startRect.left + previousContentOffsetsRef.current.controlsFromLeft);
        animateContentPosition(controls, previousControlsTop, undefined, previousControlsLeft);
      }
      contentAnimationsRef.current = contentAnimations;

      if (stateChanged) {
        const stateChangeAnimations: Animation[] = [];

        const previousPromptHeight = previousContentOffsetsRef.current.promptHeight;
        if (
          !ghostParts &&
          !nextIsCollapsed &&
          prompt &&
          nextPromptRect &&
          previousPromptHeight !== null &&
          nextPromptRect.height - previousPromptHeight >= 0.5
        ) {
          const hiddenHeight = nextPromptRect.height - previousPromptHeight;
          stateChangeAnimations.push(
            prompt.animate(
              [
                { clipPath: `inset(0 0 ${String(hiddenHeight)}px 0)` },
                { clipPath: "inset(0 0 0 0)" },
              ],
              {
                duration,
                easing: COMPOSER_RESTING_TRANSITION_EASING,
              },
            ),
          );
        }

        const arrivingControls = nextIsCollapsed
          ? restingControlsRef.current
          : element.querySelector<HTMLElement>('[data-chat-composer-controls="left"]');
        if (arrivingControls && !continuousControls) {
          const drift = -COMPOSER_RESTING_CONTROLS_DRIFT_PX;
          stateChangeAnimations.push(
            arrivingControls.animate(
              [
                { opacity: 0, transform: `translateY(${String(drift)}px)` },
                { opacity: 1, transform: "none" },
              ],
              {
                duration: nextIsCollapsed ? duration : duration / 2,
                delay: nextIsCollapsed ? 0 : duration / 2,
                fill: "backwards",
                easing: COMPOSER_RESTING_TRANSITION_EASING,
              },
            ),
          );
        }

        // The footer controls leave on the same curve and clock as the strip's
        // copy arrives, so the two read as one cluster moving up and out
        // rather than two clusters at full strength. They start where the
        // footer actions start (both share the footer's row) and end lifted.
        if (leavingControls) {
          leavingControlsAnimationRef.current = leavingControls.animate(
            [
              { opacity: 1, transform: `translateY(${String(actionOffset)}px)` },
              {
                opacity: 0,
                transform: `translateY(${String(-COMPOSER_RESTING_CONTROLS_DRIFT_PX)}px)`,
              },
            ],
            {
              duration,
              fill: "forwards",
              easing: COMPOSER_RESTING_TRANSITION_EASING,
            },
          );
        }

        const arrivingImagePreviews = nextIsCollapsed
          ? Array.from(
              element.querySelectorAll<HTMLElement>('[data-chat-composer-resting-images="true"]'),
            )
          : Array.from(
              element.querySelectorAll<HTMLElement>('[data-chat-composer-expanded-image="true"]'),
            );
        for (const imagePreview of arrivingImagePreviews) {
          stateChangeAnimations.push(
            imagePreview.animate([{ opacity: 0 }, { opacity: 1 }], {
              duration: nextIsCollapsed ? duration : duration / 2,
              delay: nextIsCollapsed ? 0 : duration / 2,
              fill: "backwards",
              easing: COMPOSER_RESTING_TRANSITION_EASING,
            }),
          );
        }
        stateChangeAnimationsRef.current = stateChangeAnimations;
      }

      const finishTransition = (cancelAnimations: boolean) => {
        if (animationRef.current !== animation) return;
        if (transitionCleanupTimeoutRef.current !== null) {
          window.clearTimeout(transitionCleanupTimeoutRef.current);
          transitionCleanupTimeoutRef.current = null;
        }
        if (cancelAnimations) {
          animation.cancel();
          for (const contentAnimation of contentAnimationsRef.current) {
            contentAnimation.cancel();
          }
          for (const stateChangeAnimation of stateChangeAnimationsRef.current) {
            stateChangeAnimation.cancel();
          }
        }
        animationRef.current = null;
        animationTargetHeightRef.current = null;
        contentAnimationsRef.current = [];
        stateChangeAnimationsRef.current = [];
        // Both tweens hold their last frame until the natural layout takes
        // over in this same task.
        animation.cancel();
        stripAnimation?.cancel();
        clearTransitionStyles();
        const settledOverlayHeight = overlay?.isConnected
          ? overlay.getBoundingClientRect().height
          : null;
        if (settledOverlayHeight !== null) onOverlayHeightChange(settledOverlayHeight);
        onControlsSettled();
      };
      void animation.finished.catch(() => undefined).then(() => finishTransition(false));
      // A suspended document timeline can leave `finished` pending while
      // these measurement styles remain active. Wall-clock cleanup makes
      // the natural layout the eventual source of truth in that case.
      transitionCleanupTimeoutRef.current = window.setTimeout(
        () => finishTransition(true),
        duration + COMPOSER_RESTING_TRANSITION_CLEANUP_BUFFER_MS,
      );
    } else {
      animationTargetHeightRef.current = null;
      animationBodyHeightRef.current = null;
      if (overlayHeight !== null) onOverlayHeightChange(overlayHeight);
      onControlsSettled();
    }

    previousCollapsedRef.current = nextIsCollapsed;
    previousHeightRef.current = nextHeight;
    previousModelStripHeightRef.current = nextModelStripHeight;
    previousContentOffsetsRef.current = {
      promptFromTop: nextPromptTop === null ? null : nextPromptTop - nextRect.top,
      promptHeight: nextPromptRect?.height ?? null,
      placeholderFromTop: nextPlaceholderTop === null ? null : nextPlaceholderTop - nextRect.top,
      actionFromBottom: nextActionTop === null ? null : nextRect.bottom - nextActionTop,
      controlsFromBottom: nextControlsTop === null ? null : nextRect.bottom - nextControlsTop,
      controlsFromLeft: nextControlsRect === null ? null : nextControlsRect.left - nextRect.left,
      surfaceBottomInset: overlayRect ? overlayRect.bottom - nextRect.bottom : null,
    };
  };

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- runs the FLIP animation against committed DOM geometry before paint when the collapsed state changes
  useLayoutEffect(() => {
    const requestId = transitionLayoutRequestRef.current + 1;
    transitionLayoutRequestRef.current = requestId;
    const stateChanged = previousCollapsedRef.current !== isCollapsed;
    // A non-Git context strip enters or leaves flow through ChatView state in
    // an earlier layout effect. Let React flush that parent update before the
    // FLIP reads its destination geometry, while still running before paint.
    queueMicrotask(() => {
      if (transitionLayoutRequestRef.current !== requestId) return;
      transitionToCurrentGeometry(stateChanged);
    });
    return () => {
      if (transitionLayoutRequestRef.current === requestId) {
        transitionLayoutRequestRef.current += 1;
      }
    };
  }, [isCollapsed, transitionToCurrentGeometry]);

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- measures the committed overlay element and reports its height when the resting state changes
  useLayoutEffect(() => {
    if (previousRestingRef.current === isResting) return;
    previousRestingRef.current = isResting;
    if (animationRef.current) return;
    const overlay = elementRef.current?.closest<HTMLElement>('[data-chat-composer-overlay="true"]');
    if (overlay) onOverlayHeightChange(overlay.getBoundingClientRect().height);
  }, [isResting, onOverlayHeightChange]);

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- observes composer and body resize to record geometry and retarget a running animation
  useLayoutEffect(() => {
    const element = elementRef.current;
    if (!element) return;

    const body = element.querySelector<HTMLElement>('[data-chat-composer-body="true"]');
    return observeResize(body ? [element, body] : element, (entries) => {
      if (animationRef.current) {
        // The commit that started the tween resizes the body too, and that
        // geometry was already measured. Only a body that differs from it
        // needs a retarget, which restarts the tween from the current height.
        if (
          body &&
          entries.some((entry) => entry.target === body) &&
          (animationBodyHeightRef.current === null ||
            Math.abs(body.getBoundingClientRect().height - animationBodyHeightRef.current) >= 0.5)
        ) {
          transitionToCurrentGeometry(false);
        }
        return;
      }
      const elementRect = element.getBoundingClientRect();
      const visibleTransitionElement = (selector: string) =>
        Array.from(element.querySelectorAll<HTMLElement>(selector)).find(
          (candidate) => candidate.getClientRects().length > 0,
        ) ?? null;
      const promptElement = visibleTransitionElement(
        '[data-composer-prompt-surface="true"], [data-testid="composer-editor"], [data-chat-composer-transition-prompt="true"]',
      );
      const promptRect = promptElement?.getBoundingClientRect();
      const actionTop = visibleTransitionElement(
        '[data-chat-composer-transition-actions="true"]',
      )?.getBoundingClientRect().top;
      const controlsRect = (
        isCollapsedRef.current
          ? restingControlsRef.current
          : visibleTransitionElement('[data-chat-composer-controls="left"]')
      )?.getBoundingClientRect();
      previousHeightRef.current = elementRect.height;
      const placeholderElement = element.querySelector<HTMLElement>(
        '[data-composer-placeholder="true"]',
      );
      previousContentOffsetsRef.current = {
        promptFromTop: promptElement ? composerTextTop(promptElement) - elementRect.top : null,
        promptHeight: promptRect?.height ?? null,
        placeholderFromTop: placeholderElement
          ? composerTextTop(placeholderElement) - elementRect.top
          : null,
        actionFromBottom: actionTop === undefined ? null : elementRect.bottom - actionTop,
        controlsFromBottom:
          controlsRect === undefined ? null : elementRect.bottom - controlsRect.top,
        controlsFromLeft: controlsRect === undefined ? null : controlsRect.left - elementRect.left,
        surfaceBottomInset:
          (element
            .closest<HTMLElement>('[data-chat-composer-overlay="true"]')
            ?.getBoundingClientRect().bottom ?? elementRect.bottom) - elementRect.bottom,
      };
    });
  }, [restingControlsRef, transitionToCurrentGeometry]);

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- clears the cleanup timer, cancels Web Animations and strips inline transition styles on unmount
  useEffect(() => {
    hasCompletedInitialLayoutRef.current = true;
    return () => {
      if (transitionCleanupTimeoutRef.current !== null) {
        window.clearTimeout(transitionCleanupTimeoutRef.current);
        transitionCleanupTimeoutRef.current = null;
      }
      animationRef.current?.cancel();
      animationRef.current = null;
      animationTargetHeightRef.current = null;
      for (const animation of contentAnimationsRef.current) animation.cancel();
      contentAnimationsRef.current = [];
      for (const animation of stateChangeAnimationsRef.current) animation.cancel();
      stateChangeAnimationsRef.current = [];
      leavingControlsAnimationRef.current?.cancel();
      leavingControlsAnimationRef.current = null;
      clearTransitionStyles();
    };
  }, [clearTransitionStyles]);

  return elementRef;
}
