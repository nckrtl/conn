import type { OrbitGatewayBranches } from "@t3tools/client-runtime/orbit-gateway";
import { useRouter } from "@tanstack/react-router";
import { GitBranchIcon, RotateCcwIcon } from "lucide-react";
import { useEffect, useState } from "react";

import { openOrbitInstanceById } from "../orbit/openOrbitDraft";
import {
  ORBIT_BRANCH_MODE_LABELS,
  createOrbitBranchSearch,
  orbitBranchControlLabel,
  orbitBranchListStatus,
  orbitBranchMenuMode,
  orbitBranchMenuRows,
  takeOrbitBranchMenuRequest,
  type OrbitBranchListState,
  type OrbitBranchMode,
  type OrbitBranchRow,
} from "../orbit/orbitBranchControl";
import type { OrbitDraftTarget } from "../orbit/orbitDraft";
import { readOrbitBranches, readOrbitEnvironments } from "../orbit/orbitPaletteProjects";
import { ComposerContextLabel } from "./ComposerContextLabel";
import { ComposerControl, ComposerControlIcon } from "./chat/ComposerControl";
import { Button } from "./ui/button";
import {
  Combobox,
  ComboboxItem,
  ComboboxList,
  ComboboxPopup,
  ComboboxSearchInput,
  ComboboxStatus,
  ComboboxTrigger,
} from "./ui/combobox";
import { MiddleTruncate } from "./ui/middle-truncate";
import { toastManager } from "./ui/toast";
import { Toggle, ToggleGroup } from "./ui/toggle-group";

/**
 * Conn: the branch of a new Instance in an Orbit draft's context row. "From main" by default
 * (the create sends no branch); a menu cuts a new branch from another one, or works on an
 * existing branch. A branch another Instance works on selects that Instance instead.
 */
export function BranchToolbarOrbitBranch({
  target,
  onTargetChange,
  readBranches = readOrbitBranches,
}: {
  target: OrbitDraftTarget;
  /** Applies a change to the draft's current target. */
  onTargetChange: (patch: Partial<OrbitDraftTarget>) => void;
  readBranches?: (projectId: number, query: string) => Promise<OrbitGatewayBranches>;
}) {
  const router = useRouter();
  const [openedByChangeBranch] = useState(() => takeOrbitBranchMenuRequest(target.projectId));
  const [open, setOpen] = useState(openedByChangeBranch);
  const [mode, setMode] = useState<OrbitBranchMode>(() => orbitBranchMenuMode(target));
  const [query, setQuery] = useState("");
  const [list, setList] = useState<{ state: OrbitBranchListState; query: string }>({
    state: { status: "loading" },
    query: "",
  });
  const [search] = useState(() =>
    createOrbitBranchSearch({
      read: (text) => readBranches(target.projectId, text),
      onState: (state, text) => setList({ state, query: text }),
      onDefaultBranch: (name) => {
        if (name !== target.defaultBranch) onTargetChange({ defaultBranch: name });
      },
    }),
  );

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- reads the list when Change branch opened the menu on mount, and drops a pending read on unmount
  useEffect(() => {
    if (openedByChangeBranch) search.readNow("");
    return () => search.dispose();
  }, [openedByChangeBranch, search]);

  const onOpenChange = (next: boolean) => {
    setOpen(next);
    if (next) {
      setMode(orbitBranchMenuMode(target));
      search.readNow(query);
    } else {
      search.dispose();
    }
  };

  const rows =
    list.state.status === "loaded"
      ? orbitBranchMenuRows({ list: list.state.list, mode, current: target.branch ?? null })
      : [];
  const status = orbitBranchListStatus(list.state, list.query);
  const label = orbitBranchControlLabel(target);

  const pick = (row: OrbitBranchRow) => {
    if (row.action.kind === "disabled") return;
    setOpen(false);
    search.dispose();
    if (row.action.kind === "branch") {
      onTargetChange({ branch: row.action.selection });
      return;
    }
    const instance = row.action.instance;
    void openOrbitInstanceById({
      router,
      project: {
        id: target.projectId,
        slug: target.projectSlug,
        name: target.projectName,
        nodeName: target.nodeName,
        domainSuffix: target.domainSuffix,
      },
      instance,
      environments: readOrbitEnvironments,
    })
      .then((result) => {
        if (result.kind === "unavailable") {
          toastManager.add({
            type: "error",
            title: `Could not open Instance ${instance.name}`,
            description: result.reason,
          });
        }
      })
      .catch((error: unknown) =>
        toastManager.add({
          type: "error",
          title: `Could not open Instance ${instance.name}`,
          description: error instanceof Error ? error.message : String(error),
        }),
      );
  };

  return (
    <Combobox
      items={rows.map((row) => row.name)}
      filteredItems={rows.map((row) => row.name)}
      autoHighlight
      open={open}
      onOpenChange={onOpenChange}
      value={rows.find((row) => row.selected)?.name ?? null}
    >
      <ComboboxTrigger
        render={<ComposerControl size="xs" data-composer-context-control />}
        className="min-w-0 max-w-full active:scale-100"
        aria-label={`Branch: ${label}. Click to change.`}
        data-orbit-branch-control
      >
        <ComposerControlIcon icon={GitBranchIcon} size="xs" />
        <ComposerContextLabel>
          <MiddleTruncate value={label} variant="cap-aligned" className="w-full" />
        </ComposerContextLabel>
      </ComboboxTrigger>
      <ComboboxPopup className="w-80" data-orbit-branch-menu>
        <div className="shrink-0 px-3 pt-2.5">
          <ToggleGroup
            aria-label="Branch mode"
            className="w-full *:flex-1"
            value={[mode]}
            onValueChange={(next) => {
              const value = next[0];
              if (value === "new" || value === "existing") setMode(value);
            }}
          >
            <Toggle value="new">{ORBIT_BRANCH_MODE_LABELS.new}</Toggle>
            <Toggle value="existing">{ORBIT_BRANCH_MODE_LABELS.existing}</Toggle>
          </ToggleGroup>
        </div>
        <ComboboxSearchInput
          placeholder="Search branches..."
          value={query}
          onChange={(event) => {
            setQuery(event.target.value);
            search.search(event.target.value);
          }}
        />
        <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
          <ComboboxList className="max-h-64">
            {rows.map((row, index) => (
              <ComboboxItem
                key={row.name}
                index={index}
                value={row.name}
                disabled={row.action.kind === "disabled"}
                onClick={() => pick(row)}
                data-orbit-branch-row={row.name}
              >
                <span className="flex min-w-0 flex-1 flex-col items-start">
                  <span className="flex w-full min-w-0 items-center gap-1.5">
                    <span className="min-w-0 truncate font-mono text-xs">{row.name}</span>
                    {row.pullRequestLabel ? (
                      <span className="shrink-0 text-xs text-muted-foreground">
                        {row.pullRequestLabel}
                      </span>
                    ) : null}
                  </span>
                  {row.note ? (
                    <span className="truncate text-xs text-muted-foreground">{row.note}</span>
                  ) : null}
                </span>
              </ComboboxItem>
            ))}
          </ComboboxList>
          {status ? (
            <div className="flex items-center justify-between gap-2">
              <ComboboxStatus data-orbit-branch-status>{status}</ComboboxStatus>
              {list.state.status === "failed" && list.state.retry ? (
                <Button
                  type="button"
                  size="xs"
                  variant="ghost-muted"
                  className="me-2"
                  onClick={() => search.readNow(query)}
                >
                  <RotateCcwIcon aria-hidden />
                  Retry
                </Button>
              ) : null}
            </div>
          ) : null}
        </div>
      </ComboboxPopup>
    </Combobox>
  );
}
