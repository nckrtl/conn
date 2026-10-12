import { cn } from "~/lib/utils";

/** Underlined tabs for the API panel's request and response sections (panel chrome size). */
export function ApiTabs<T extends string>({
  value,
  tabs,
  onChange,
  trailing,
  className,
}: {
  className?: string;
  value: T;
  tabs: ReadonlyArray<{
    readonly id: T;
    readonly label: string;
    readonly count?: number | undefined;
  }>;
  onChange: (tab: T) => void;
  trailing?: React.ReactNode;
}) {
  return (
    <div
      className={cn(
        "flex h-9 shrink-0 items-stretch gap-4 border-b border-(--shell-divider)! ps-4 pe-toolbar-end",
        className,
      )}
    >
      {tabs.map((tab) => (
        <button
          key={tab.id}
          type="button"
          onClick={() => onChange(tab.id)}
          className={cn(
            "relative flex cursor-pointer items-center gap-1.5 rounded-sm text-ui outline-none focus-visible:ring-1 focus-visible:ring-ring",
            value === tab.id ? "text-foreground" : "text-muted-foreground hover:text-foreground",
          )}
        >
          {tab.label}
          {tab.count ? (
            <span className="text-muted-foreground tabular-nums">{tab.count}</span>
          ) : null}
          {value === tab.id ? (
            <span className="absolute inset-x-0 -bottom-px h-0.5 rounded-full bg-primary" />
          ) : null}
        </button>
      ))}
      {trailing ? <div className="ms-auto flex min-w-0 items-center gap-2">{trailing}</div> : null}
    </div>
  );
}
