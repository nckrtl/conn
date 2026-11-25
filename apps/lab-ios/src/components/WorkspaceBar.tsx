import { OfflinePill } from "./OfflinePill";
import type { IconName } from "../icons.generated";
import { Icon } from "./Icon";
import "./WorkspaceBar.css";

const TABS: ReadonlyArray<{ id: string; icon: IconName }> = [
  { id: "threads", icon: "thread" },
  { id: "tasks", icon: "checklist" },
  { id: "pull-requests", icon: "pull-request" },
  { id: "search", icon: "search" },
];

/** The floating bottom bar: a menu circle, the tab pill, a compose circle. */
export type WorkspaceTab = "thread-list" | "tasks" | "pull-requests";
export function WorkspaceBar({
  active,
  offline = false,
  onTab,
  onSettings,
  onNew,
  searching,
  onSearch,
  query,
  onQuery,
}: {
  active: WorkspaceTab;
  offline?: boolean;
  onTab: (tab: WorkspaceTab) => void;
  onSettings: () => void;
  onNew: () => void;
  searching: boolean;
  onSearch: (search: boolean) => void;
  query: string;
  onQuery: (q: string) => void;
}) {
  return (
    <div className="m-wsbar">
      {offline && <OfflinePill />}
      {searching ? (
        <>
          <label className="ios-search-field">
            <Icon name="search" size={18} />
            <input
              autoFocus
              aria-label="Search"
              placeholder={
                "Search " +
                { "thread-list": "threads", tasks: "tasks", "pull-requests": "pull requests" }[
                  active
                ]
              }
              value={query}
              onChange={(e) => onQuery(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Escape") onSearch(false);
              }}
            />
          </label>
          <button
            className="m-wsbar-circle"
            onClick={() => onSearch(false)}
            aria-label="Cancel search"
          >
            ×
          </button>
        </>
      ) : (
        <>
          <button className="m-wsbar-circle" onClick={onSettings} aria-label="Open settings">
            <Icon name="more-horizontal" size={20} />
          </button>
          <div className="m-wsbar-tabs">
            {TABS.map((tab) => {
              const id = tab.id === "threads" ? "thread-list" : tab.id;
              return (
                <button
                  key={id}
                  className="m-wsbar-tab"
                  aria-label={
                    (
                      {
                        "thread-list": "Threads",
                        tasks: "Tasks",
                        "pull-requests": "Pull requests",
                        search: "Search",
                      } as Record<string, string>
                    )[id]
                  }
                  data-active={id === active}
                  onClick={() => (id === "search" ? onSearch(true) : onTab(id as WorkspaceTab))}
                >
                  <Icon name={tab.icon} size={22} />
                </button>
              );
            })}
          </div>
          <button
            className="m-wsbar-circle"
            onClick={onNew}
            disabled={offline}
            aria-label="New chat"
          >
            <Icon name="add" size={20} />
          </button>
        </>
      )}
    </div>
  );
}
