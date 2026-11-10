import { ImageIcon, PlusIcon } from "lucide-react";
import { useEffect, useRef, useState } from "react";

import { isCommandPaletteOpen, openCommandPalette } from "../../commandPaletteBus";
import { cn } from "../../lib/utils";
import { workspaceImageFromFile } from "../../lib/workspaceImage";
import { useWorkspaceStore } from "../../workspaceStore";
import {
  groupProjectsByConnection,
  nextWorkspaceColor,
  WORKSPACE_COLORS,
  type Workspace,
  type WorkspaceColor,
  type WorkspaceProject,
  workspaceProjectRefs,
} from "../../workspaces.logic";
import { EnvironmentMachineIcon } from "../EnvironmentMachineIcon";
import { Button } from "../ui/button";
import { Checkbox } from "../ui/checkbox";
import {
  Dialog,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "../ui/dialog";
import { Input } from "../ui/input";
import { Label } from "../ui/label";
import { WORKSPACE_COLOR_CLASSES, WORKSPACE_ICONS, WorkspaceBadge } from "./workspaceVisuals";

/**
 * Surface of the Letter, Image and icon pickers: the unchecked Checkbox look
 * (fill above the dialog, `input` border above that fill). List it before the
 * selected `border-foreground` so the selection wins.
 */
const PICKER_BUTTON_SURFACE =
  "flex h-7 items-center justify-center rounded-md border border-input bg-background dark:bg-input/32";

/**
 * Creates a workspace ("new") or edits one. The caller remounts it (a new
 * `key`) each time it opens, so the form starts from the target.
 */
export function WorkspaceDialog({
  open,
  target,
  onClose,
}: {
  open: boolean;
  target: Workspace | "new";
  onClose: () => void;
}) {
  const workspaces = useWorkspaceStore((state) => state.workspaces);
  const availableProjects = useWorkspaceStore((state) => state.availableProjects);
  const createWorkspace = useWorkspaceStore((state) => state.createWorkspace);
  const updateWorkspace = useWorkspaceStore((state) => state.updateWorkspace);
  const deleteWorkspace = useWorkspaceStore((state) => state.deleteWorkspace);
  const selectWorkspace = useWorkspaceStore((state) => state.selectWorkspace);
  const editing = target === "new" ? null : target;

  const [name, setName] = useState(editing?.name ?? "");
  const [color, setColor] = useState<WorkspaceColor>(
    () => editing?.color ?? nextWorkspaceColor(workspaces),
  );
  const [icon, setIcon] = useState<string | null>(editing?.icon ?? null);
  // An uploaded picture replaces the icon and letter; choosing either clears it.
  const [image, setImage] = useState<string | null>(editing?.image ?? null);
  const imageInputRef = useRef<HTMLInputElement>(null);
  const chooseIcon = (next: string | null) => {
    setIcon(next);
    setImage(null);
  };
  const pickImage = async (file: File | undefined) => {
    if (!file) return;
    try {
      setImage(await workspaceImageFromFile(file));
      setError(null);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  };
  const [projectKeys, setProjectKeys] = useState<string[]>(() => [
    ...(workspaceProjectRefs(editing, availableProjects) ?? []),
    ...(editing?.projectKeys ?? []).filter(
      (key) => !availableProjects.some((project) => project.projectKey === key),
    ),
  ]);
  const [error, setError] = useState<string | null>(null);

  // Projects the workspace has but the sidebar doesn't show now (an environment
  // is offline) stay listed, so saving never drops them silently.
  const scoped = availableProjects.flatMap((project) =>
    project.refs.map((ref) => ({
      ...project,
      projectKey: ref,
      refs: [ref],
      connections: (project.connections ?? []).filter((connection) =>
        ref.startsWith(`${connection.environmentId}:`),
      ),
    })),
  );
  const known = new Set(scoped.map((project) => project.projectKey));
  const unavailable = [
    ...(editing?.projectRefs ?? []),
    ...(editing?.projectKeys ?? []).filter(
      (key) => !availableProjects.some((project) => project.projectKey === key),
    ),
  ];
  const projects: WorkspaceProject[] = [
    ...scoped,
    ...unavailable
      .filter((key) => !known.has(key))
      .map((key) => ({
        projectKey: key,
        displayName: `${key} (not available now)`,
        refs: [],
      })),
  ];
  // Listed under the connection each project lives on, so projects on this Mac
  // and on other machines are told apart (rooms-patches).
  const sections = groupProjectsByConnection(projects);

  const save = () => {
    const legacyKeys = new Set(editing?.projectKeys ?? []);
    const draft = {
      name,
      color,
      icon,
      image,
      projectKeys: projectKeys.filter((key) => legacyKeys.has(key)),
      projectRefs: projectKeys.filter((key) => !legacyKeys.has(key)),
    };
    try {
      if (editing) {
        updateWorkspace(editing.id, draft);
      } else {
        selectWorkspace(createWorkspace(draft).id);
      }
      onClose();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  };

  // "Add project" runs the app's own add-project flow (the command palette opens
  // over this dialog). The flow only navigates to the project, so the project
  // that appears next in the sidebar's list is the one just added: remember the
  // refs known now and check the first new one.
  const refsBeforeAdd = useRef<ReadonlySet<string> | null>(null);
  const addProject = () => {
    refsBeforeAdd.current = new Set(availableProjects.flatMap((project) => project.refs));
    openCommandPalette({ open: "add-project" });
  };
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- adds projects that appear in the registry after the user started adding one
  useEffect(() => {
    const before = refsBeforeAdd.current;
    if (!before) return;
    const added = availableProjects
      .flatMap((project) => project.refs)
      .filter((ref) => !before.has(ref));
    if (added.length === 0) return;
    refsBeforeAdd.current = null;
    setProjectKeys((keys) => [...new Set([...keys, ...added])]);
  }, [availableProjects]);

  const toggleProject = (key: string, checked: boolean) =>
    setProjectKeys((keys) =>
      checked ? [...new Set([...keys, key])] : keys.filter((k) => k !== key),
    );

  return (
    <Dialog
      open={open}
      onOpenChange={(next, eventDetails) => {
        if (next) return;
        // The add-project palette is a separate dialog over this one. Its Escape
        // and backdrop clicks must not also close this form.
        if (
          (eventDetails.reason === "escape-key" || eventDetails.reason === "outside-press") &&
          isCommandPaletteOpen()
        ) {
          eventDetails.cancel();
          return;
        }
        onClose();
      }}
    >
      <DialogPopup className="max-w-md">
        <DialogHeader>
          <DialogTitle>{editing ? `Edit ${editing.name}` : "New workspace"}</DialogTitle>
          <DialogDescription>
            A workspace shows only the threads of its projects. Workspaces are saved in this app
            only.
          </DialogDescription>
        </DialogHeader>
        <DialogPanel>
          <form
            className="grid gap-4"
            onSubmit={(event) => {
              event.preventDefault();
              save();
            }}
          >
            <div className="flex items-end gap-3">
              <WorkspaceBadge
                workspace={{ name: name || "?", color, icon, image }}
                className="size-9"
              />
              <div className="grid flex-1 gap-1.5">
                <Label htmlFor="workspace-name">Name</Label>
                <Input
                  id="workspace-name"
                  placeholder="Orbit"
                  value={name}
                  onChange={(event) => setName(event.target.value)}
                  autoFocus
                />
              </div>
            </div>

            <div className="grid gap-1.5">
              <Label>Color</Label>
              {/* Same 12 columns as the icons below, so the two grids line up. */}
              <div className="grid grid-cols-12 gap-1">
                {WORKSPACE_COLORS.map((option) => (
                  <button
                    key={option}
                    type="button"
                    aria-label={option}
                    aria-pressed={color === option}
                    onClick={() => setColor(option)}
                    className={cn(
                      "aspect-square rounded-md -outline-offset-2",
                      WORKSPACE_COLOR_CLASSES[option],
                      color === option && "outline-2 outline-foreground",
                    )}
                  />
                ))}
              </div>
            </div>

            <div className="grid gap-1.5">
              <Label>Icon</Label>
              {/* Letter and Image take 5 of 12 columns, so both rows of icons fill the width. */}
              <div className="grid grid-cols-12 gap-1">
                <button
                  type="button"
                  aria-pressed={icon === null && image === null}
                  onClick={() => chooseIcon(null)}
                  className={cn(
                    PICKER_BUTTON_SURFACE,
                    "col-span-2 px-2 text-xs",
                    icon === null && image === null && "border-foreground",
                  )}
                >
                  Letter
                </button>
                <button
                  type="button"
                  aria-label={image ? "Replace image" : "Upload image"}
                  aria-pressed={image !== null}
                  onClick={() => imageInputRef.current?.click()}
                  className={cn(
                    PICKER_BUTTON_SURFACE,
                    "col-span-3 gap-1.5 px-2 text-xs",
                    image !== null && "border-foreground",
                  )}
                >
                  {image ? (
                    <img alt="" src={image} className="size-4 rounded-sm object-cover" />
                  ) : (
                    <ImageIcon className="size-4" />
                  )}
                  Image
                </button>
                <input
                  ref={imageInputRef}
                  type="file"
                  accept="image/png,image/jpeg,image/webp,image/gif,image/svg+xml"
                  className="hidden"
                  onChange={(event) => {
                    void pickImage(event.target.files?.[0]);
                    event.target.value = "";
                  }}
                />
                {Object.entries(WORKSPACE_ICONS).map(([key, Icon]) => (
                  <button
                    key={key}
                    type="button"
                    aria-label={key}
                    aria-pressed={icon === key && image === null}
                    onClick={() => chooseIcon(key)}
                    className={cn(
                      PICKER_BUTTON_SURFACE,
                      icon === key && image === null && "border-foreground",
                    )}
                  >
                    <Icon className="size-4" />
                  </button>
                ))}
              </div>
            </div>

            <div className="grid gap-1.5">
              <div className="flex items-center justify-between">
                <Label>Projects</Label>
                <Button variant="ghost" size="xs" onClick={addProject}>
                  <PlusIcon />
                  Add project
                </Button>
              </div>
              {projects.length === 0 ? (
                <p className="text-muted-foreground text-sm">No projects yet.</p>
              ) : (
                <div className="grid max-h-72 grid-cols-1 gap-3 overflow-y-auto rounded-md border border-border p-2">
                  {sections.map(({ connection, projects: sectionProjects }) => {
                    const sectionKeys = sectionProjects.map((project) => project.projectKey);
                    const allSelected = sectionKeys.every((key) => projectKeys.includes(key));
                    const sectionId = connection?.environmentId ?? "unknown";
                    return (
                      <section
                        key={sectionId}
                        aria-label={connection?.label ?? "Not connected"}
                        className="grid min-w-0 grid-cols-1 gap-1"
                      >
                        <div className="flex items-center gap-1.5 text-muted-foreground text-xs">
                          {connection ? (
                            <EnvironmentMachineIcon
                              aria-hidden
                              kind={connection.kind}
                              className="size-3.5 shrink-0"
                            />
                          ) : null}
                          <span className="truncate font-medium text-foreground">
                            {connection?.label ?? "Not connected"}
                          </span>
                          {connection?.primary ? <span>· this machine</span> : null}
                          <button
                            type="button"
                            className="ml-auto shrink-0 rounded px-1 hover:text-foreground focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring outline-none"
                            onClick={() =>
                              setProjectKeys((current) =>
                                allSelected
                                  ? current.filter((key) => !sectionKeys.includes(key))
                                  : [...new Set([...current, ...sectionKeys])],
                              )
                            }
                          >
                            {allSelected ? "Clear" : "Select all"}
                          </button>
                        </div>
                        {sectionProjects.map((project) => {
                          const id = `workspace-project-${sectionId}-${project.projectKey}`;
                          const elsewhere = (project.connections ?? [])
                            .filter((other) => other.environmentId !== connection?.environmentId)
                            .map((other) => other.label);
                          return (
                            <div
                              key={project.projectKey}
                              className="flex min-w-0 items-center gap-2 pl-5"
                            >
                              <Checkbox
                                id={id}
                                checked={projectKeys.includes(project.projectKey)}
                                onCheckedChange={(checked) =>
                                  toggleProject(project.projectKey, checked === true)
                                }
                              />
                              <Label htmlFor={id} className="min-w-0 flex-1">
                                <span className="min-w-0 truncate">{project.displayName}</span>
                                {elsewhere.length > 0 ? (
                                  <span className="shrink-0 text-muted-foreground text-xs font-normal">
                                    also on {elsewhere.join(", ")}
                                  </span>
                                ) : null}
                              </Label>
                            </div>
                          );
                        })}
                      </section>
                    );
                  })}
                </div>
              )}
            </div>
            {error ? (
              <p role="alert" className="text-destructive text-sm">
                {error}
              </p>
            ) : null}
          </form>
        </DialogPanel>
        <DialogFooter variant="bare">
          {editing ? (
            <Button
              variant="destructive-outline"
              className="mr-auto"
              onClick={() => {
                deleteWorkspace(editing.id);
                onClose();
              }}
            >
              Delete
            </Button>
          ) : null}
          <Button variant="outline" onClick={onClose}>
            Cancel
          </Button>
          <Button onClick={save}>{editing ? "Save" : "Create"}</Button>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}
