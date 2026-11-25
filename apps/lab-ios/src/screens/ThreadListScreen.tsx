import { useState } from "react";
import { FilterPopover, ListHeader } from "../components/FilteredListHeader";
import { ProjectListRow } from "../components/ProjectListRow";
import type { ListThread } from "../data/fixtures";
import "./ThreadListScreen.css";

const environments = { laptop: "Local", server: "Server", cloud: "Cloud" } as const;

export function ThreadListScreen({
  rows,
  open,
  query,
  light,
}: {
  rows: readonly ListThread[];
  open: (row: ListThread) => void;
  query: string;
  light: boolean;
}) {
  const [project, setProject] = useState("");
  const [environment, setEnvironment] = useState("");
  const search = query.trim().toLowerCase();
  const visibleRows = rows.filter(
    (row) =>
      (!project || row.project === project) &&
      (!environment || environments[row.machine] === environment) &&
      [row.title, row.project, row.branch].join(" ").toLowerCase().includes(search),
  );
  const groups = [
    {
      name: "Environments",
      all: "All environments",
      options: [...new Set(rows.map((row) => environments[row.machine]))],
      selected: environment,
      select: setEnvironment,
    },
    {
      name: "Projects",
      all: "All projects",
      options: [...new Set(rows.map((row) => row.project))],
      selected: project,
      select: setProject,
    },
  ];
  return (
    <div className="m-list">
      <div className="m-tasks-scroll m-scroll">
        <ListHeader
          title="Threads"
          subtitle={`${visibleRows.length} ${visibleRows.length === 1 ? "thread" : "threads"}`}
        >
          <FilterPopover filterLabel="Filter threads">
            {(close) =>
              groups.map((group) => (
                <div
                  className="ios-filter-options"
                  role="group"
                  aria-label={group.name}
                  key={group.name}
                >
                  <div className="ios-filter-heading">{group.name}</div>
                  {["", ...group.options].map((option) => (
                    <button
                      key={option}
                      aria-pressed={group.selected === option}
                      onClick={() => {
                        group.select(option);
                        close();
                      }}
                    >
                      {option || group.all}
                      {group.selected === option ? " ✓" : ""}
                    </button>
                  ))}
                </div>
              ))
            }
          </FilterPopover>
        </ListHeader>
        {visibleRows.map((t) => (
          <ProjectListRow
            key={t.key ?? t.title}
            project={t.project}
            light={light}
            status={t.state}
            title={t.title}
            onOpen={() => open(t)}
          >
            <span className="ios-sparkle">✦</span> · {t.project}
            {t.branch ? " · " + t.branch : ""} · {t.time}
          </ProjectListRow>
        ))}
      </div>
    </div>
  );
}
