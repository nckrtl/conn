import { useEffect, useState } from "react";

import { cn } from "~/lib/utils";

import { useOrbitTool } from "../context";
import type { OrbitDependencies } from "../orbit";
import { cellClass, EmptyRow, headRowClass, rowClass, tableClass } from "./parts";

import { SortHeader, sortTableRows, useTableSort } from "./tableSort";

type DependencyTab = "composer" | "javascript";

export function useOrbitDependencies() {
  const { state, source } = useOrbitTool();
  const instanceId = state.status === "ready" ? state.page.instanceId : null;
  const [loaded, setLoaded] = useState<{
    source: typeof source;
    instanceId: number;
    data?: OrbitDependencies;
    error?: string;
  }>();
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- loads the Instance's dependency report from Orbit
  useEffect(() => {
    if (!source || instanceId === null) return;
    let cancelled = false;
    void source.dependencies(instanceId).then(
      (data) => {
        if (!cancelled) setLoaded({ source, instanceId, data });
      },
      (error: unknown) => {
        if (!cancelled)
          setLoaded({
            source,
            instanceId,
            error: error instanceof Error ? error.message : "Could not load dependencies.",
          });
      },
    );
    return () => {
      cancelled = true;
    };
  }, [source, instanceId]);
  const result =
    loaded?.source === source && loaded?.instanceId === instanceId ? loaded : undefined;
  return result;
}

export function DependenciesPanel({
  tab,
  result,
}: {
  tab: DependencyTab;
  result: ReturnType<typeof useOrbitDependencies>;
}) {
  const dependencies = result?.data;
  const sorting = useTableSort();
  const packages = dependencies?.[tab];
  const sortedPackages = sortTableRows(packages ?? [], sorting.sort, (dependency, column) => {
    if (column === "name") return dependency.name;
    if (column === "version") return dependency.version;
    if (column === "constraint") return dependency.constraint;
    return dependency.development ? "Dev" : "Production";
  });

  return (
    <div className="flex min-h-0 flex-1">
      <div className="min-h-0 min-w-0 flex-1 overflow-auto">
        {packages == null ? (
          <EmptyRow>
            {result?.error ??
              dependencies?.errors?.[tab] ??
              (dependencies
                ? "No saved inventory. Run an Orbit dependency scan for this instance."
                : "Loading dependencies…")}
          </EmptyRow>
        ) : packages.length === 0 ? (
          <EmptyRow>No {tab === "composer" ? "Composer" : "JavaScript"} dependencies</EmptyRow>
        ) : (
          <table className={cn(tableClass, "min-w-lg")}>
            <colgroup>
              <col />
              <col className="w-28" />
              <col className="w-28" />
              <col className="w-24" />
            </colgroup>
            <thead>
              <tr className={headRowClass}>
                <SortHeader column="name" label="Package" {...sorting} />
                <SortHeader column="version" label="Version" {...sorting} />
                <SortHeader column="constraint" label="Requirement" {...sorting} />
                <SortHeader column="type" label="Type" {...sorting} />
              </tr>
            </thead>
            <tbody>
              {sortedPackages.map((dependency) => (
                <tr
                  key={dependency.id ?? `${dependency.name}:${dependency.version}`}
                  className={rowClass}
                >
                  <td className={cellClass}>
                    <span className="block truncate font-mono">{dependency.name}</span>
                  </td>
                  <td className={cellClass}>
                    <span className="font-mono tabular-nums">{dependency.version ?? "–"}</span>
                  </td>
                  <td className={cellClass}>
                    <span className="font-mono text-muted-foreground">
                      {dependency.constraint ?? "–"}
                    </span>
                  </td>
                  <td className={cellClass}>
                    <span className="text-muted-foreground">
                      {dependency.development ? "Dev" : "Production"}
                    </span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}
