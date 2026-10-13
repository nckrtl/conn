import {
  MorphIcon as BaseMorphIcon,
  type MorphIconProps as BaseMorphIconProps,
} from "morphicons/react";
import { useLayoutEffect, useRef } from "react";

import { useConnIconScope, type LucideIcon, type LucideProps } from "../icons/connIcon";
import { lucideNodes } from "../icons/lucide";

const REDUCED_MOTION_QUERY = "(prefers-reduced-motion: reduce)";

interface MorphIconProps extends Omit<LucideProps, "ref"> {
  readonly icon: LucideIcon;
  readonly reducedMotion?: "user" | "always" | "never";
}

/**
 * Morphs between icon shapes when `icon` changes. Conn: inside a `ConnIconScope`
 * the icons are Phosphor, which morphicons cannot morph (it needs strokes), so
 * they crossfade instead.
 */
export function MorphIcon({ icon: Icon, reducedMotion = "user", ...props }: MorphIconProps) {
  const scoped = useConnIconScope();
  const ref = useRef<SVGSVGElement>(null);
  const previous = useRef(Icon);
  useLayoutEffect(() => {
    if (previous.current === Icon) return;
    previous.current = Icon;
    const reduce =
      reducedMotion === "always" ||
      (reducedMotion === "user" && window.matchMedia(REDUCED_MOTION_QUERY).matches);
    if (!scoped || reduce) return;
    ref.current?.animate(
      [
        { opacity: 0, transform: "scale(0.6)" },
        { opacity: 1, transform: "scale(1)" },
      ],
      { duration: 160, easing: "cubic-bezier(0.2, 0, 0, 1)" },
    );
  }, [Icon, reducedMotion, scoped]);
  const node = lucideNodes.get(Icon);
  if (!scoped && node) {
    return (
      <BaseMorphIcon
        reducedMotion={reducedMotion}
        // Lucide's svg props allow explicit `undefined`, which morphicons' types reject.
        {...(props as Omit<BaseMorphIconProps, "icon">)}
        icon={node}
      />
    );
  }
  return <Icon ref={ref} {...props} />;
}
