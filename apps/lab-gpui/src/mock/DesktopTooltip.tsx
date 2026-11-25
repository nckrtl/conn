import { useEffect, useRef } from "react";

/** One top-layer tooltip can cross the resizable panel and scroll boundaries. */
export function DesktopTooltip() {
  const ref = useRef<HTMLDivElement>(null);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- delegates hover and keyboard focus for the desktop shell
  useEffect(() => {
    const tip = ref.current!;
    const shell = tip.parentElement!;
    const findAnchor = (target: EventTarget | null) =>
      target instanceof Element ? target.closest<HTMLElement>("[data-tip]") : null;
    function hide() {
      if (tip.matches(":popover-open")) tip.hidePopover();
    }
    function show(event: Event) {
      const anchor = findAnchor(event.target);
      if (!anchor?.dataset.tip) return;
      tip.textContent = anchor.dataset.tip;
      tip.showPopover();
      const rect = anchor.getBoundingClientRect();
      const box = tip.getBoundingClientRect();
      const left = rect.left + (rect.width - box.width) / 2;
      tip.style.left = Math.max(4, Math.min(left, window.innerWidth - box.width - 4)) + "px";
      tip.style.top =
        (rect.bottom + box.height + 8 <= window.innerHeight
          ? rect.bottom + 4
          : Math.max(4, rect.top - box.height - 4)) + "px";
    }
    function leave(event: PointerEvent | FocusEvent) {
      if (findAnchor(event.target) !== findAnchor(event.relatedTarget)) hide();
    }
    shell.addEventListener("pointerover", show);
    shell.addEventListener("pointerout", leave);
    shell.addEventListener("focusin", show);
    shell.addEventListener("focusout", leave);
    shell.addEventListener("pointerdown", hide);
    shell.addEventListener("keydown", hide);
    window.addEventListener("scroll", hide, true);
    window.addEventListener("resize", hide);
    return () => {
      shell.removeEventListener("pointerover", show);
      shell.removeEventListener("pointerout", leave);
      shell.removeEventListener("focusin", show);
      shell.removeEventListener("focusout", leave);
      shell.removeEventListener("pointerdown", hide);
      shell.removeEventListener("keydown", hide);
      window.removeEventListener("scroll", hide, true);
      window.removeEventListener("resize", hide);
    };
  }, []);
  return <div className="desktop-tooltip" ref={ref} popover="manual" role="tooltip" />;
}
