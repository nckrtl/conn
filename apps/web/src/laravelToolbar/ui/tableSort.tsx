import { ArrowDown, ArrowUp } from "lucide-react";
import { useState } from "react";

import { cn } from "~/lib/utils";

import { headCellClass } from "./parts";

export type TableSort = { column: string; direction: "ascending" | "descending" } | null;
type SortValue = string | number | null | undefined;

export function nextTableSort(sort: TableSort, column: string): TableSort {
  if (sort?.column !== column) return { column, direction: "ascending" };
  return sort.direction === "ascending" ? { column, direction: "descending" } : null;
}

export function sortTableRows<T>(
  rows: readonly T[],
  sort: TableSort,
  value: (row: T, column: string) => SortValue,
): readonly T[] {
  if (!sort) return rows;
  return rows.toSorted((left, right) => {
    const a = value(left, sort.column);
    const b = value(right, sort.column);
    // Missing values stay at the bottom in either direction. Equal values retain source order.
    if (a == null) return b == null ? 0 : 1;
    if (b == null) return -1;
    const compared =
      typeof a === "number" && typeof b === "number"
        ? a - b
        : String(a).localeCompare(String(b), undefined, { numeric: true, sensitivity: "base" });
    return sort.direction === "ascending" ? compared : -compared;
  });
}

export function useTableSort() {
  const [sort, setSort] = useState<TableSort>(null);
  return { sort, onSort: (column: string) => setSort((current) => nextTableSort(current, column)) };
}

export function SortHeader({
  column,
  label,
  sort,
  onSort,
  className,
  align = "left",
}: {
  column: string;
  label: string;
  sort: TableSort;
  onSort: (column: string) => void;
  className?: string;
  align?: "left" | "right";
}) {
  const direction = sort?.column === column ? sort.direction : "none";
  const next =
    direction === "none"
      ? "ascending"
      : direction === "ascending"
        ? "descending"
        : "original order";
  return (
    <th scope="col" aria-sort={direction} className={cn(headCellClass, className)}>
      <button
        type="button"
        aria-label={`${label}: sort ${next}`}
        onClick={() => onSort(column)}
        className={cn(
          "flex h-9 w-full cursor-pointer items-center gap-1 text-left outline-none hover:text-foreground focus-visible:ring-1 focus-visible:ring-ring focus-visible:ring-inset",
          align === "right" && "justify-end text-right",
        )}
      >
        <span className="truncate">{label}</span>
        {direction === "ascending" ? <ArrowUp className="size-3 shrink-0" /> : null}
        {direction === "descending" ? <ArrowDown className="size-3 shrink-0" /> : null}
      </button>
    </th>
  );
}
