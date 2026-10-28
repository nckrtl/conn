import { cva, type VariantProps } from "class-variance-authority";
import type * as React from "react";

import { cn } from "~/lib/utils";

const kbdVariants = cva(
  "pointer-events-none inline-flex h-5 min-w-5 select-none items-center justify-center gap-1 rounded px-1 font-medium font-sans text-xs [&_svg:not([class*='size-'])]:size-3",
  {
    defaultVariants: { variant: "default" },
    variants: {
      variant: {
        default: "bg-foreground/[0.07] text-muted-foreground",
        // A cap one step lighter than the surface it sits on, with a light glyph.
        raised: "bg-(--shell-highlight) text-foreground/90",
      },
    },
  },
);

function Kbd({
  className,
  variant,
  ...props
}: React.ComponentProps<"kbd"> & VariantProps<typeof kbdVariants>) {
  return <kbd className={cn(kbdVariants({ variant }), className)} data-slot="kbd" {...props} />;
}

function KbdGroup({ className, ...props }: React.ComponentProps<"kbd">) {
  return (
    <kbd
      className={cn("inline-flex items-center gap-1", className)}
      data-slot="kbd-group"
      {...props}
    />
  );
}

export { Kbd, KbdGroup };
