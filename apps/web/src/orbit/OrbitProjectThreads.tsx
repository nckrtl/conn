import type { OrbitGatewayProject } from "@t3tools/client-runtime/orbit-gateway";
import { orbitThreadStartStep, startableOrbitProject } from "@t3tools/client-runtime/orbit-gateway";
import { useNavigate, useRouter } from "@tanstack/react-router";
import { BoxIcon, RotateCcwIcon, XIcon } from "lucide-react";
import { useEffect, useState } from "react";

import { SidebarHeaderIconButton } from "../components/sidebar/SidebarThreadHeader";
import { Button } from "../components/ui/button";
import {
  Dialog,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "../components/ui/dialog";
import { Label } from "../components/ui/label";
import {
  Select,
  SelectItem,
  SelectPopup,
  SelectTrigger,
  SelectValue,
} from "../components/ui/select";
import { Textarea } from "../components/ui/textarea";
import { toastManager } from "../components/ui/toast";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../components/ui/tooltip";
import { buildThreadRouteParams } from "../threadRoutes";
import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import { useOrbitThreadsAvailable } from "./environmentProvider";
import { desktopOrbitGatewayClient } from "./OrbitProfileSync";
import {
  beginOrbitThreadStart,
  dismissOrbitThreadStart,
  orbitPendingThreadPath,
  retryOrbitThreadStart,
  runSavedOrbitThreadStart,
  stillOnStartRoute,
} from "./orbitThreadStarts";
import { useOrbitThreadStarts } from "./orbitThreadStartStore";

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Runs the saved thread starts and opens each thread once its first message is sent. Mounted once,
 * in the main window, so no start runs twice.
 */
export function OrbitThreadStartRunner() {
  const available = useOrbitThreadsAvailable();
  const starts = useOrbitThreadStarts((state) => state.starts);
  const navigate = useNavigate();
  const router = useRouter();

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- runs each saved start that has not stopped
  useEffect(() => {
    const client = desktopOrbitGatewayClient();
    if (!available || client === null) return;
    for (const start of starts) {
      if (start.error !== null || start.sentAt != null) continue;
      void runSavedOrbitThreadStart(client, start.id).then((sent) => {
        // A pending thread's own view hands over and shows the error; elsewhere a toast does.
        const onPendingThread =
          start.pendingThread === true &&
          router.state.location.pathname === orbitPendingThreadPath(start.id);
        if (sent !== null) {
          const open = () =>
            void navigate({
              to: "/$environmentId/$threadId",
              params: buildThreadRouteParams(scopeThreadRef(sent.environmentId, sent.threadId)),
            });
          if (onPendingThread) return;
          // Open the thread only when Nick is still where he started it; otherwise offer it.
          if (!start.pendingThread && stillOnStartRoute(start.id, router.state.location.pathname)) {
            open();
            return;
          }
          const id = toastManager.add({
            type: "success",
            title: `Thread started in ${start.projectSlug}`,
            actionProps: {
              children: "Open",
              onClick: () => {
                toastManager.close(id);
                open();
              },
            },
          });
          return;
        }
        const stopped = useOrbitThreadStarts
          .getState()
          .starts.find((entry) => entry.id === start.id);
        if (stopped?.error && !onPendingThread) {
          toastManager.add({
            type: "error",
            title: `Could not start the thread in ${stopped.projectSlug}`,
            description: stopped.error,
          });
        }
      });
    }
  }, [available, navigate, router, starts]);

  return null;
}

/** The sidebar header button that starts a thread in an Orbit Project. */
export function OrbitThreadStartButton() {
  const available = useOrbitThreadsAvailable();
  const [open, setOpen] = useState(false);
  const [projects, setProjects] = useState<readonly OrbitGatewayProject[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  if (!available) return null;
  const openDialog = () => {
    setOpen(true);
    setLoadError(null);
    const client = desktopOrbitGatewayClient();
    if (!client) return;
    client.projects().then(
      (list) => setProjects(list.flatMap((row) => startableOrbitProject(row) ?? [])),
      (error: unknown) => setLoadError(message(error)),
    );
  };
  return (
    <>
      <SidebarHeaderIconButton label="New thread in an Orbit project" onClick={openDialog}>
        <BoxIcon />
      </SidebarHeaderIconButton>
      <OrbitThreadDialog
        open={open}
        onOpenChange={setOpen}
        projects={projects}
        loadError={loadError}
      />
    </>
  );
}

function OrbitThreadDialog(props: {
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  readonly projects: readonly OrbitGatewayProject[] | null;
  readonly loadError: string | null;
}) {
  const { projects, loadError } = props;
  const router = useRouter();
  const [chosenId, setChosenId] = useState<string | null>(null);
  const [text, setText] = useState("");

  const project = projects?.find((entry) => String(entry.id) === chosenId) ?? projects?.[0] ?? null;
  const canStart = project !== null && text.trim() !== "";
  const start = () => {
    if (!project || text.trim() === "") return;
    beginOrbitThreadStart(project, text.trim(), router.state.location.pathname);
    setText("");
    props.onOpenChange(false);
  };

  return (
    <Dialog open={props.open} onOpenChange={(next) => props.onOpenChange(next)}>
      <DialogPopup className="max-w-lg">
        <DialogHeader>
          <DialogTitle>New thread in an Orbit project</DialogTitle>
          <DialogDescription>
            Orbit creates a clone of the project's default instance, and the thread starts there
            with this message.
          </DialogDescription>
        </DialogHeader>
        <DialogPanel>
          <form
            className="grid gap-4"
            onSubmit={(event) => {
              event.preventDefault();
              start();
            }}
          >
            <div className="grid gap-2">
              <Label>Project</Label>
              {loadError ? (
                <p className="text-ui text-destructive">{loadError}</p>
              ) : projects !== null && projects.length === 0 ? (
                <p className="text-ui text-muted-foreground">
                  No Orbit project has a default instance in a container that this device reaches.
                </p>
              ) : (
                <Select
                  value={project ? String(project.id) : ""}
                  onValueChange={(next) => setChosenId(String(next))}
                >
                  <SelectTrigger aria-label="Project" disabled={projects === null}>
                    <SelectValue>
                      {project ? `${project.name} · ${project.nodeName}` : "Loading…"}
                    </SelectValue>
                  </SelectTrigger>
                  <SelectPopup>
                    {(projects ?? []).map((entry) => (
                      <SelectItem key={entry.id} value={String(entry.id)}>
                        {entry.name} · {entry.nodeName}
                      </SelectItem>
                    ))}
                  </SelectPopup>
                </Select>
              )}
            </div>
            <div className="grid gap-2">
              <Label htmlFor="orbit-thread-message">First message</Label>
              <Textarea
                id="orbit-thread-message"
                rows={5}
                value={text}
                placeholder="What should the agent do?"
                onChange={(event) => setText(event.currentTarget.value)}
                onKeyDown={(event) => {
                  if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
                    event.preventDefault();
                    start();
                  }
                }}
              />
            </div>
          </form>
        </DialogPanel>
        <DialogFooter variant="bare">
          <Button variant="outline" onClick={() => props.onOpenChange(false)}>
            Cancel
          </Button>
          <Button disabled={!canStart} onClick={start}>
            Start thread
          </Button>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}

const STEP_LABELS = {
  creating: "Creating the clone",
  pairing: "Pairing",
  sending: "Sending the first message",
} as const;

/** The thread starts still on their way, with Dismiss, and Retry for one that stopped. */
export function OrbitThreadStartList() {
  const available = useOrbitThreadsAvailable();
  // Palette starts show as pending thread rows instead.
  const starts = useOrbitThreadStarts((state) => state.starts).filter(
    (start) => !start.pendingThread,
  );
  if (!available || starts.length === 0) return null;
  return (
    <ul className="mt-1 grid gap-0.5" aria-label="Orbit thread starts">
      {starts.map((start) => (
        <li
          key={start.id}
          className="flex items-center gap-2 rounded-md px-2 py-1 text-ui text-sidebar-muted-foreground"
        >
          <BoxIcon className="size-3.5 shrink-0" />
          <Tooltip>
            <TooltipTrigger render={<span className="min-w-0 flex-1 truncate" />}>
              <span className="text-sidebar-foreground">{start.projectSlug}</span>
              {" · "}
              {start.error ? "Stopped" : `${STEP_LABELS[orbitThreadStartStep(start)]}…`}
            </TooltipTrigger>
            <TooltipPopup side="right">{start.error ?? start.message}</TooltipPopup>
          </Tooltip>
          {start.error ? (
            <Button
              size="icon-micro"
              variant="ghost-muted"
              aria-label="Retry"
              onClick={() => retryOrbitThreadStart(start.id)}
            >
              <RotateCcwIcon className="size-3" />
            </Button>
          ) : null}
          {/* A running start can be dismissed too; it stops following Orbit at its next step. */}
          <Button
            size="icon-micro"
            variant="ghost-muted"
            aria-label="Dismiss"
            onClick={() => dismissOrbitThreadStart(start.id)}
          >
            <XIcon className="size-3" />
          </Button>
        </li>
      ))}
    </ul>
  );
}
