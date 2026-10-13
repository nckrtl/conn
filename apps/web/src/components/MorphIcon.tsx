import { useLayoutEffect, useRef } from "react";

import type { LucideIcon, LucideProps } from "../icons/connIcon";

const REDUCED_MOTION_QUERY = "(prefers-reduced-motion: reduce)";

interface MorphIconProps extends Omit<LucideProps, "ref"> {
  readonly icon: LucideIcon;
  readonly reducedMotion?: "user" | "always" | "never";
}

/**
 * Conn: renders a Conn icon and crossfades when `icon` changes. Phosphor icons are
 * filled, so they can't use morphicons' stroke morph.
 */
export function MorphIcon({ icon: Icon, reducedMotion = "user", ...props }: MorphIconProps) {
  const ref = useRef<SVGSVGElement>(null);
  const previous = useRef(Icon);
  useLayoutEffect(() => {
    if (previous.current === Icon) return;
    previous.current = Icon;
    const reduce =
      reducedMotion === "always" ||
      (reducedMotion === "user" && window.matchMedia(REDUCED_MOTION_QUERY).matches);
    if (reduce) return;
    ref.current?.animate(
      [
        { opacity: 0, transform: "scale(0.6)" },
        { opacity: 1, transform: "scale(1)" },
      ],
      { duration: 160, easing: "cubic-bezier(0.2, 0, 0, 1)" },
    );
  }, [Icon, reducedMotion]);
  return <Icon ref={ref} {...props} />;
}
