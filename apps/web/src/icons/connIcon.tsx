import type { Icon as PhosphorIcon, IconProps, IconWeight } from "@phosphor-icons/react";
import { ScanIcon } from "@phosphor-icons/react/dist/csr/Scan";
import { createLucideIcon as createOriginalLucideIcon, type IconNode } from "lucide-react-original";
import {
  forwardRef,
  type ForwardRefExoticComponent,
  type RefAttributes,
  type SVGProps,
} from "react";

export interface LucideProps
  extends RefAttributes<SVGSVGElement>, Partial<SVGProps<SVGSVGElement>> {
  size?: string | number;
  absoluteStrokeWidth?: boolean;
}

export type LucideIcon = ForwardRefExoticComponent<
  Omit<LucideProps, "ref"> & RefAttributes<SVGSVGElement>
>;

/**
 * Wraps a Phosphor icon in Lucide's props: `size` defaults to 24, stroke props are
 * ignored, and the svg keeps Lucide's `lucide-<name>` class for selectors.
 */
export function connIcon(
  Icon: PhosphorIcon,
  name: string,
  weight: IconWeight = "fill",
  options: { readonly mirrored?: boolean } = {},
): LucideIcon {
  const ConnIcon = forwardRef<SVGSVGElement, Omit<LucideProps, "ref">>(function ConnIcon(
    { size = 24, strokeWidth: _strokeWidth, absoluteStrokeWidth: _absolute, className, ...props },
    ref,
  ) {
    return (
      <Icon
        ref={ref}
        size={size}
        weight={weight}
        mirrored={options.mirrored ?? false}
        aria-hidden={props["aria-label"] === undefined}
        className={className ? `lucide-${name} ${className}` : `lucide-${name}`}
        // Lucide's svg props allow explicit `undefined`, which Phosphor's types reject.
        {...(props as IconProps)}
      />
    );
  });
  ConnIcon.displayName = name;
  return ConnIcon;
}

// Hand-drawn Lucide icons upstream builds with `createLucideIcon`, by name.
const CUSTOM_ICONS: Record<string, LucideIcon> = {
  "snap-shot": connIcon(ScanIcon, "snap-shot"),
};

export function createLucideIcon(iconName: string, iconNode: IconNode): LucideIcon {
  return CUSTOM_ICONS[iconName] ?? createOriginalLucideIcon(iconName, iconNode);
}
