import type { ComponentProps } from "react";

import { cn } from "../../lib/utils";

/** Shared settings card surface, with optional separators between rows. */
export function SettingsGroup({
  variant = "grouped",
  divided = true,
  className,
  ...props
}: ComponentProps<"div"> & {
  variant?: "grouped" | "plain";
  divided?: boolean;
}) {
  return (
    <div
      {...props}
      className={cn(
        "relative overflow-visible text-foreground",
        variant === "grouped"
          ? "rounded-lg border border-(--shell-settings-card-border)! border-t-(--shell-settings-card-divider)! bg-(--shell-settings-card) [--contrast-input:var(--shell-settings-card-input)] [--muted-foreground:var(--muted-foreground-raised)]"
          : "space-y-1",
        variant === "grouped" &&
          divided &&
          "[&>*+*]:border-t [&>*+*]:border-(--shell-settings-card-divider)! [&_[data-slot=settings-row]]:rounded-none [&>[data-slot=animated-height]:not(:has([data-slot=settings-row]))]:border-t-0",
        className,
      )}
    />
  );
}
