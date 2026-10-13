import type { Icon as PhosphorIcon, IconProps, IconWeight } from "@phosphor-icons/react";
import {
  createLucideIcon,
  type LucideIcon as OriginalLucideIcon,
  type LucideProps as OriginalLucideProps,
} from "lucide-react-original";
import {
  createContext,
  forwardRef,
  use,
  type ForwardRefExoticComponent,
  type ReactNode,
  type RefAttributes,
} from "react";

export { createLucideIcon };
export type LucideProps = OriginalLucideProps;
export type LucideIcon = OriginalLucideIcon;

const ConnIconScopeContext = createContext(false);

/** Conn: icons inside this scope (the thread timeline) draw Phosphor instead of Lucide. */
export function ConnIconScope(props: { readonly children: ReactNode }) {
  return <ConnIconScopeContext value={true}>{props.children}</ConnIconScopeContext>;
}

export function useConnIconScope() {
  return use(ConnIconScopeContext);
}

/**
 * Pairs a Lucide icon with a Phosphor one under Lucide's props. Outside a
 * `ConnIconScope` it renders the Lucide icon unchanged. Inside, it renders the
 * Phosphor icon: `size` defaults to 24, stroke props are ignored, and the svg
 * keeps Lucide's `lucide-<name>` class for selectors.
 */
export function connIcon(
  Phosphor: PhosphorIcon,
  Lucide: LucideIcon,
  name: string,
  weight: IconWeight = "fill",
  options: { readonly mirrored?: boolean } = {},
): LucideIcon {
  const ConnIcon = forwardRef<SVGSVGElement, Omit<LucideProps, "ref">>(
    function ConnIcon(props, ref) {
      const scoped = useConnIconScope();
      if (!scoped) return <Lucide ref={ref} {...props} />;
      const {
        size = 24,
        strokeWidth: _strokeWidth,
        absoluteStrokeWidth: _absolute,
        className,
        ...rest
      } = props;
      return (
        <Phosphor
          ref={ref}
          size={size}
          weight={weight}
          mirrored={options.mirrored ?? false}
          aria-hidden={rest["aria-label"] === undefined}
          className={className ? `lucide-${name} ${className}` : `lucide-${name}`}
          // Lucide's svg props allow explicit `undefined`, which Phosphor's types reject.
          {...(rest as IconProps)}
        />
      );
    },
  ) as ForwardRefExoticComponent<Omit<LucideProps, "ref"> & RefAttributes<SVGSVGElement>>;
  ConnIcon.displayName = name;
  return ConnIcon;
}
