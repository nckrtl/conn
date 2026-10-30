import { mergeProps } from "@base-ui/react/merge-props";
import { Select as SelectPrimitive } from "@base-ui/react/select";
import { useRender } from "@base-ui/react/use-render";
import type { ComponentType, SVGProps } from "react";

import { cn } from "~/lib/utils";
import { SelectButton } from "../ui/select";

export type ComposerControlSize = "sm" | "xs";

/**
 * `composer` is the borderless toolbar look. `field` is the outlined form-field look of the
 * `Select` trigger (`size="sm"`), for pickers that sit in a settings row beside real Selects.
 */
export type ComposerControlAppearance = "composer" | "field";

/**
 * The composer toolbar's control look. `sm` is the expanded toolbar; `xs` is the dimmer resting
 * strip. `aria-pressed` marks a toggle that is on (plan mode). This is an app control, not a
 * restyled Button, so it owns its classes.
 */
function composerControlClassName(size: ComposerControlSize, className?: string) {
  const shared =
    "relative inline-flex shrink-0 cursor-pointer items-center whitespace-nowrap rounded-(--control-radius) border outline-none disabled:pointer-events-none disabled:opacity-64 data-disabled:pointer-events-none data-disabled:opacity-64 pointer-coarse:after:absolute pointer-coarse:after:size-full pointer-coarse:after:min-h-11 pointer-coarse:after:min-w-11 [&:active:not([aria-haspopup])]:scale-[0.97] [&_svg]:pointer-events-none [&_svg]:shrink-0";
  return cn(
    shared,
    "justify-center border-transparent text-base hover:bg-accent data-pressed:bg-accent focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring focus-visible:ring-offset-1 focus-visible:ring-offset-background [&_svg]:-mx-0.5 [&_svg[data-composer-control-icon]]:mx-0",
    "[&_:is([data-composer-control-label],[data-chat-provider-model-picker-label])]:[text-box:trim-both_cap_alphabetic] supports-[text-box:trim-both_cap_alphabetic]:[&_:is([data-composer-control-label],[data-chat-provider-model-picker-label])]:py-1.5",
    size === "xs"
      ? "h-7 gap-1 px-1.75 font-normal text-foreground/70 text-sm hover:text-foreground dark:text-muted-foreground sm:h-6 sm:text-xs [&_svg:not([class*='size-'])]:size-4 sm:[&_svg:not([class*='size-'])]:size-3.5 [&_svg[data-composer-control-chevron]]:ms-0 [&_svg[data-composer-control-chevron]]:-me-1"
      : "h-7 gap-1.5 px-2 font-medium text-foreground/80 [&_svg:not([class*='text-'])]:text-muted-foreground hover:text-foreground sm:text-sm [&_svg:not([class*='size-'])]:size-4.5 sm:[&_svg:not([class*='size-'])]:size-4",
    "aria-pressed:bg-accent aria-pressed:text-accent-foreground aria-pressed:hover:bg-accent/80",
    className,
  );
}

type ComposerControlProps = useRender.ComponentProps<"button"> & {
  size?: ComposerControlSize;
  appearance?: ComposerControlAppearance;
};

export function ComposerControl({
  className,
  size = "sm",
  appearance = "composer",
  render,
  ...props
}: ComposerControlProps) {
  if (appearance === "field") {
    // The Select trigger itself (with its own chevron), sized to its content in a wrapping row.
    // Callers' className only tunes the composer bar's layout, so it does not apply here.
    return <SelectButton size="sm" className="w-auto min-w-0" render={render} {...props} />;
  }
  return <ComposerControlButton size={size} className={className} render={render} {...props} />;
}

function ComposerControlButton({
  className,
  size = "sm",
  render,
  ...props
}: Omit<ComposerControlProps, "appearance">) {
  const defaultProps = {
    className: composerControlClassName(size, className),
    type: render ? undefined : ("button" as const),
  };
  return useRender({
    defaultTagName: "button",
    props: mergeProps<"button">(defaultProps, props),
    render,
  });
}

export function ComposerControlIcon({
  icon: Icon,
  className,
  opticalSize = "default",
  size = "sm",
}: {
  icon: ComponentType<SVGProps<SVGSVGElement>>;
  className?: string | undefined;
  opticalSize?: "default" | "large";
  size?: ComposerControlSize;
}) {
  return (
    <Icon
      aria-hidden="true"
      className={cn(
        "shrink-0",
        size === "xs" ? "size-3" : opticalSize === "large" ? "size-4.5" : "size-4",
        className,
      )}
      data-composer-control-icon
    />
  );
}

export function ComposerSelectControl({
  className,
  children,
  size = "sm",
  ...props
}: Omit<SelectPrimitive.Trigger.Props, "className"> & {
  className?: string | undefined;
  size?: ComposerControlSize;
}) {
  return (
    <SelectPrimitive.Trigger className={composerControlClassName(size, className)} {...props}>
      {children}
    </SelectPrimitive.Trigger>
  );
}
