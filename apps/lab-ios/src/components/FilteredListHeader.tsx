import { type ReactNode, useState } from "react";
import { GlassButton } from "./GlassHeader";

interface FilterMenuProps<T extends string> {
  filterLabel: string;
  options: readonly { label: T; count: number }[];
  selected: T;
  onSelect: (value: T) => void;
}

export function FilterPopover({
  filterLabel,
  children,
}: {
  filterLabel: string;
  children: (close: () => void) => ReactNode;
}) {
  const [expanded, setExpanded] = useState(false);
  return (
    <div className="ios-filter">
      <GlassButton
        icon="filter"
        label={filterLabel}
        size={19}
        expanded={expanded}
        onClick={() => setExpanded(!expanded)}
      />
      {expanded && (
        <div className="ios-menu ios-list-filter-menu" role="group" aria-label={filterLabel}>
          {children(() => setExpanded(false))}
        </div>
      )}
    </div>
  );
}

export function FilterMenu<T extends string>({
  filterLabel,
  options,
  selected,
  onSelect,
}: FilterMenuProps<T>) {
  return (
    <FilterPopover filterLabel={filterLabel}>
      {(close) =>
        options.map(({ label, count }) => (
          <button
            key={label}
            type="button"
            aria-pressed={label === selected}
            onClick={() => {
              onSelect(label);
              close();
            }}
          >
            {label} · {count}
            {label === selected ? " ✓" : ""}
          </button>
        ))
      }
    </FilterPopover>
  );
}

export function ListHeader({
  title,
  subtitle,
  children,
}: {
  title: string;
  subtitle?: string | undefined;
  children: ReactNode;
}) {
  return (
    <header className="m-tasks-bar">
      <div className="m-tasks-title">
        <h1 className="m-tasks-title-text">{title}</h1>
        {subtitle && <div className="m-tasks-subtitle">{subtitle}</div>}
      </div>
      <div className="m-tasks-filter">{children}</div>
    </header>
  );
}

export function FilteredListHeader<T extends string>({
  title,
  subtitle,
  ...filter
}: FilterMenuProps<T> & { title: string; subtitle?: string | undefined }) {
  return (
    <ListHeader title={title} subtitle={subtitle}>
      <FilterMenu {...filter} />
    </ListHeader>
  );
}
