import {
  APPEARANCE_SECTION,
  DESKTOP_DEVICE_SECTION,
  orbitConnectionChecks,
  orbitNodeServers,
  type EnvironmentProvider,
  type OrbitConnectionCheckState,
  type OrbitConnectionProbe,
  type OrbitGatewayEnvironment,
  type OrbitGatewayNode,
  type OrbitGatewayProfile,
  type OrbitNodeState,
  type ProfileSectionName,
} from "@t3tools/client-runtime/orbit-gateway";
import { useNavigate } from "@tanstack/react-router";
import { CheckIcon, XIcon } from "lucide-react";
import { useEffect, useRef, useState } from "react";

import { setEnvironmentProvider, useEnvironmentProvider } from "~/orbit/environmentProvider";
import {
  desktopOrbitGatewayClient,
  forceOrbitProfileSync,
  syncOrbitProfileNow,
  useOrbitProfileSyncStatus,
} from "~/orbit/OrbitProfileSync";
import { backupLocalSections, restoreSectionBackup } from "~/orbit/profileSyncRegistry";
import {
  setGroupSyncEnabled,
  SYNC_GROUPS,
  useProfileSyncBackups,
  useProfileSyncOptOuts,
  type SyncGroup,
} from "~/orbit/profileSyncStorage";
import { useEnvironments } from "~/state/environments";

import { cn } from "~/lib/utils";

import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { Spinner } from "../ui/spinner";
import { Switch } from "../ui/switch";
import { toastManager } from "../ui/toast";
import { SettingsPageContainer, SettingsRow, SettingsSection } from "./settingsLayout";
import { searchableSetting, SETTINGS_SECTION_LABELS } from "./settingsSearch";
import { useMessages } from "gt-react";
import { useStableCallback } from "~/hooks/useStableCallback";

interface GatewayView {
  readonly node: OrbitGatewayNode;
  readonly profiles: readonly OrbitGatewayProfile[];
}

const PROVIDER_LABELS: Record<EnvironmentProvider, string> = {
  default: "Default",
  orbit: "Orbit",
};

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function relativeTime(at: number | null): string {
  if (at === null) return "not yet";
  const seconds = Math.round((Date.now() - at) / 1000);
  if (seconds < 60) return "just now";
  const minutes = Math.round(seconds / 60);
  return minutes < 60 ? `${minutes} min ago` : `${Math.round(minutes / 60)} h ago`;
}

/**
 * Where this device's environments come from: the ones added here (Default) or the T3 servers on
 * the Orbit Gateway (Orbit). Only the desktop app can reach the Gateway, so a browser never offers
 * Orbit.
 */
export function EnvironmentProviderSection() {
  const provider = useEnvironmentProvider((state) => state.provider);
  const orbitAvailable = !!window.desktopBridge?.orbitGatewaySend;
  if (!orbitAvailable && provider === "default") return null;

  return (
    <SettingsSection {...searchableSetting("environment-provider")}>
      <SettingsRow
        title="Environments from"
        description={
          provider === "orbit"
            ? "The T3 servers registered on the Orbit Gateway. Host servers pair automatically. Instances are managed in the Orbit panel. Environments added here are switched off until you choose Default again."
            : "Environments you add on this device. Orbit uses the servers on the Orbit Gateway instead and syncs workspaces with your profile."
        }
        control={
          <Select
            value={provider}
            onValueChange={(next) => {
              if (next === "default" || next === "orbit") setEnvironmentProvider(next);
            }}
          >
            <SelectTrigger size="sm" aria-label="Environments from">
              <SelectValue>{PROVIDER_LABELS[provider]}</SelectValue>
            </SelectTrigger>
            <SelectPopup align="end" alignItemWithTrigger={false}>
              <SelectItem value="default">{PROVIDER_LABELS.default}</SelectItem>
              {orbitAvailable ? (
                <SelectItem value="orbit">{PROVIDER_LABELS.orbit}</SelectItem>
              ) : null}
            </SelectPopup>
          </Select>
        }
      />
    </SettingsSection>
  );
}

const SYNC_GROUP_LABELS: Record<SyncGroup, string> = {
  appearance: "Appearance",
  device: "This desktop's settings",
};

function changedLine(
  label: string,
  change: { readonly updatedAt: string | null; readonly updatedBy: string | null } | undefined,
): string | null {
  if (!change) return null;
  const at = change.updatedAt === null ? Number.NaN : Date.parse(change.updatedAt);
  const when = Number.isNaN(at) ? "" : ` ${relativeTime(at)}`;
  return `${label}: changed${change.updatedBy ? ` by ${change.updatedBy}` : ""}${when}`;
}

/**
 * What the profile shares beyond workspaces: the appearance on every device, and this desktop's
 * settings with the user's other desktops. Each can be turned off on this device only.
 */
function ProfileSyncSection({ profileName }: { readonly profileName: string | null }) {
  const sync = useOrbitProfileSyncStatus();
  const optOuts = useProfileSyncOptOuts();
  const backups = useProfileSyncBackups();
  const unsupported = sync.sections === "unsupported";
  const disabled = profileName === null;

  const enabledSections = (Object.keys(SYNC_GROUPS) as SyncGroup[])
    .filter((group) => !optOuts[group])
    .map((group): ProfileSectionName => SYNC_GROUPS[group]);
  const backedUp = ([APPEARANCE_SECTION, DESKTOP_DEVICE_SECTION] as const).filter(
    (name) => backups[name] !== undefined,
  );
  const backupTime = Math.max(0, ...backedUp.map((name) => backups[name]?.savedAt ?? 0));
  const changes = [
    changedLine("Appearance", sync.sectionChanges?.[APPEARANCE_SECTION]),
    changedLine("This desktop's settings", sync.sectionChanges?.[DESKTOP_DEVICE_SECTION]),
  ].filter((line): line is string => line !== null);

  const statusTitle =
    sync.phase === "error"
      ? "Sync failed"
      : profileName === null
        ? "No profile"
        : unsupported
          ? "Workspaces only"
          : "Synced";
  const statusDescription =
    sync.phase === "error"
      ? sync.error
      : profileName === null
        ? "Choose a profile to sync workspaces, appearance and settings."
        : unsupported
          ? `Gateway doesn't support profile sync yet. Workspaces still sync with ${profileName}.`
          : sync.phase === "synced"
            ? `Synced with ${profileName}. Last synced ${relativeTime(sync.syncedAt)}.`
            : "Waiting for the first sync.";

  const toggle = (group: SyncGroup, enabled: boolean) => {
    setGroupSyncEnabled(group, enabled);
    syncOrbitProfileNow();
  };
  const force = (direction: "push" | "pull") => {
    if (direction === "pull") backupLocalSections(enabledSections);
    forceOrbitProfileSync(direction, enabledSections);
    toastManager.add({
      type: "info",
      title: "Profile sync",
      description:
        direction === "push"
          ? "Sending this device's settings to the profile."
          : "Replacing this device's settings with the profile's. Restore previous settings undoes it.",
    });
  };
  const restore = () => {
    const restored = backedUp.filter((name) => restoreSectionBackup(name));
    toastManager.add({
      type: restored.length > 0 ? "success" : "error",
      title: "Profile sync",
      description:
        restored.length > 0
          ? "Previous settings restored. They replace the profile's at the next sync."
          : "Nothing to restore yet. Try again in a moment.",
    });
  };

  return (
    <SettingsSection id="orbit-profile-sync" title="Profile sync">
      <SettingsRow
        title={statusTitle}
        description={statusDescription}
        status={
          sync.sectionsError ? (
            `Appearance and settings: ${sync.sectionsError}`
          ) : changes.length > 0 ? (
            <ul>
              {changes.map((line) => (
                <li key={line}>{line}</li>
              ))}
            </ul>
          ) : undefined
        }
        control={
          <Button size="xs" variant="outline" disabled={disabled} onClick={syncOrbitProfileNow}>
            Sync now
          </Button>
        }
      />
      {(Object.keys(SYNC_GROUPS) as SyncGroup[]).map((group) => (
        <SettingsRow
          key={group}
          title={`Sync ${SYNC_GROUP_LABELS[group].toLowerCase()}`}
          description={
            group === "appearance"
              ? "Theme, light or dark mode, contrast and custom themes follow your profile on every device."
              : "Fonts, text sizes, chat width, glass, motion, diff and timestamp options are shared with your other desktops. Phones keep their own."
          }
          control={
            <Switch
              aria-label={`Sync ${SYNC_GROUP_LABELS[group].toLowerCase()}`}
              checked={!optOuts[group]}
              disabled={disabled || unsupported}
              onCheckedChange={(enabled) => toggle(group, enabled)}
            />
          }
        />
      ))}
      <SettingsRow
        title="Resolve differences"
        description="Replace the profile with what this device has, or this device with what the profile has."
        control={
          <div className="flex items-center gap-2">
            <Button
              size="xs"
              variant="outline"
              disabled={disabled || unsupported || enabledSections.length === 0}
              onClick={() => force("push")}
            >
              Use this device
            </Button>
            <Button
              size="xs"
              variant="outline"
              disabled={disabled || unsupported || enabledSections.length === 0}
              onClick={() => force("pull")}
            >
              Use the profile
            </Button>
          </div>
        }
      />
      {backedUp.length > 0 ? (
        <SettingsRow
          title="Restore previous settings"
          description={`What this device had before the profile's settings replaced them, saved ${relativeTime(backupTime)}.`}
          control={
            <Button size="xs" variant="outline" onClick={restore}>
              Restore
            </Button>
          }
        />
      ) : null}
    </SettingsSection>
  );
}

/**
 * This device's Node and its profiles, read on mount and after each profile sync.
 */
function useOrbitGatewayView() {
  // One client per mount: the load effect below must not restart on every render.
  const [client] = useState(desktopOrbitGatewayClient);
  const sync = useOrbitProfileSyncStatus();
  const [view, setView] = useState<GatewayView | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);

  const load = useStableCallback(async () => {
    if (!client) return;
    try {
      const [node, profiles] = await Promise.all([client.me(), client.profiles()]);
      setView({ node, profiles });
      setLoadError(null);
    } catch (error) {
      setLoadError(message(error));
    }
  });

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- reads the Orbit Gateway on mount and after each profile sync
  useEffect(() => {
    void load();
    // oxlint-disable-next-line react/exhaustive-effect-dependencies -- A finished profile sync can change the node and profiles, so the view reloads.
  }, [load, sync.syncedAt]);

  return { gateway: client, view, loadError, load };
}

function OrbitDeviceSection(props: {
  readonly view: GatewayView | null;
  readonly loadError: string | null;
  readonly onReload: () => void;
}) {
  const { view, loadError } = props;
  return (
    <SettingsSection id="orbit-device" title="Orbit Gateway">
      <SettingsRow
        title={view?.node.name ?? (loadError ? "Gateway unreachable" : "Connecting…")}
        description={
          loadError ??
          (view ? `Signed in to gateway.orbit as ${view.node.wireguardIp}` : "gateway.orbit")
        }
        control={
          <Button size="xs" variant="outline" onClick={props.onReload}>
            Reload
          </Button>
        }
      />
    </SettingsSection>
  );
}

const CHECK_BADGES: Record<
  OrbitConnectionCheckState,
  { readonly label: string; readonly variant: "success" | "error" | "outline" }
> = {
  pass: { label: "OK", variant: "success" },
  fail: { label: "Failed", variant: "error" },
  checking: { label: "Checking", variant: "outline" },
  not_checked: { label: "Not checked", variant: "outline" },
};

function CheckBadge({ state }: { readonly state: OrbitConnectionCheckState }) {
  const { label, variant } = CHECK_BADGES[state];
  return (
    <Badge variant={variant} data-check-state={state}>
      {state === "pass" ? (
        <CheckIcon />
      ) : state === "fail" ? (
        <XIcon />
      ) : state === "checking" ? (
        <Spinner />
      ) : null}
      {label}
    </Badge>
  );
}

const NODE_STATES: Record<OrbitNodeState, { readonly label: string; readonly dot: string }> = {
  paired: { label: "Paired", dot: "bg-success" },
  pairing: { label: "Pairing…", dot: "bg-muted-foreground/40" },
  expired: { label: "Registration expired", dot: "bg-warning" },
};

/**
 * The Gateway's answer to `me` (which runs the three checks) and its server list. Reload runs both
 * again; an answer to an earlier load that comes late is dropped.
 */
function useOrbitConnection() {
  // One client per mount: the load effect below must not restart on every render.
  const [client] = useState(desktopOrbitGatewayClient);
  const [probe, setProbe] = useState<OrbitConnectionProbe>({ status: "checking" });
  const [environments, setEnvironments] = useState<readonly OrbitGatewayEnvironment[] | null>(null);
  const latest = useRef(0);

  const load = useStableCallback(async () => {
    if (!client) return;
    const run = ++latest.current;
    setProbe({ status: "checking" });
    const [me, servers] = await Promise.allSettled([client.me(), client.environments()]);
    if (run !== latest.current) return;
    setProbe(
      me.status === "fulfilled"
        ? { status: "ok", node: me.value }
        : { status: "error", error: me.reason },
    );
    setEnvironments(servers.status === "fulfilled" ? servers.value : null);
  });

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- reads the Orbit Gateway once on mount; Reload reads it again
  useEffect(() => {
    void load();
  }, [load]);

  return { probe, environments, load };
}

/**
 * The Orbit panel's Connection page: this device's Node, the three checks of its connection to
 * the Gateway, and the Nodes that run a T3 server. Conn picks up the connection from the machine,
 * so a failed check says what to fix outside Conn. Instances are on the Instances page.
 */
export function OrbitConnectionPage() {
  const { probe, environments, load } = useOrbitConnection();
  const { environments: savedEnvironments } = useEnvironments();
  const navigate = useNavigate();
  const m = useMessages();
  const connectionsLabel = m(SETTINGS_SECTION_LABELS["/settings/connections"]);

  const node = probe.status === "ok" ? probe.node : null;
  const checks = orbitConnectionChecks(probe);
  const nodes =
    environments === null
      ? null
      : orbitNodeServers({
          environments,
          paired: new Set(
            savedEnvironments.map((environment) => String(environment.environmentId)),
          ),
          device: node,
        });

  return (
    <SettingsPageContainer width="wide">
      <SettingsSection id="orbit-device" title="This device" hideTitle>
        <SettingsRow
          title={node?.name ?? "This device"}
          description={
            node
              ? `Signed in to gateway.orbit as ${node.wireguardIp}`
              : probe.status === "checking"
                ? "Connecting to gateway.orbit…"
                : "The Node name and WireGuard address show once all checks pass."
          }
          control={
            <Button
              size="xs"
              variant="outline"
              disabled={probe.status === "checking"}
              onClick={() => void load()}
            >
              Reload
            </Button>
          }
        />
      </SettingsSection>

      <SettingsSection id="orbit-checks" title="Connection checks" hideTitle>
        {checks.map((check) => (
          <SettingsRow
            key={check.key}
            data-check={check.key}
            title={check.label}
            description={check.message}
            control={<CheckBadge state={check.state} />}
          />
        ))}
      </SettingsSection>

      <section id="orbit-nodes" className="space-y-2.5">
        <div className="px-3 sm:px-4">
          <h2 className="flex min-h-7 items-center text-base font-semibold text-foreground">
            Nodes
          </h2>
          <p className="text-xs text-muted-foreground">
            The Nodes that run a T3 server. Conn pairs with them automatically.
          </p>
        </div>
        <SettingsSection title="Nodes that run a T3 server" hideTitle>
          {nodes === null ? (
            <SettingsRow
              title={probe.status === "checking" ? "Loading…" : "Nodes not available"}
              description={
                probe.status === "checking"
                  ? "Reading the Nodes from gateway.orbit."
                  : probe.status === "ok"
                    ? "The Gateway did not send its list of servers. Reload to try again."
                    : "The Nodes show once the Gateway answers. Reload to try again."
              }
            />
          ) : nodes.length === 0 ? (
            <SettingsRow
              title="No Nodes yet"
              description="A Node's T3 server registers itself with the Gateway."
            />
          ) : (
            nodes.map((entry) => (
              <SettingsRow
                key={entry.environmentId}
                title={
                  <span className="flex items-center gap-2">
                    <span
                      aria-hidden
                      className={cn("size-2 shrink-0 rounded-full", NODE_STATES[entry.state].dot)}
                    />
                    {entry.name}
                  </span>
                }
                description={entry.isThisDevice ? `This device · ${entry.address}` : entry.address}
                control={
                  <span className="text-ui text-muted-foreground">
                    {NODE_STATES[entry.state].label}
                  </span>
                }
              />
            ))
          )}
        </SettingsSection>
      </section>

      <SettingsSection id="orbit-environments-from" title="Environments from Orbit" hideTitle>
        <SettingsRow
          title="Environments from Orbit"
          description={`Orbit is turned on and off in Settings > ${connectionsLabel}, with "Environments from". While it is off, the Orbit icon is hidden.`}
          control={
            <Button
              size="xs"
              variant="outline"
              onClick={() =>
                void navigate({ to: "/settings/connections", hash: "environment-provider" })
              }
            >
              Open {connectionsLabel}
            </Button>
          }
        />
      </SettingsSection>
    </SettingsPageContainer>
  );
}

/**
 * The Orbit panel's Profile page: the profile this device shares its workspaces with, and the
 * profile sync. Until the Gateway answers, or when a reload fails, it shows the device row with Reload.
 */
export function OrbitProfilePage() {
  const { gateway, view, loadError, load } = useOrbitGatewayView();
  const [newProfileName, setNewProfileName] = useState("");
  const [busy, setBusy] = useState(false);

  const bindProfile = async (profile: { readonly id: number } | { readonly name: string }) => {
    if (!gateway) return;
    setBusy(true);
    try {
      const id = "id" in profile ? profile.id : (await gateway.createProfile(profile.name)).id;
      await gateway.bindProfile(id);
      setNewProfileName("");
      await load();
      syncOrbitProfileNow();
    } catch (error) {
      toastManager.add({ type: "error", title: "Orbit", description: message(error) });
    }
    // Not in `finally`: the React Compiler cannot compile a finalizer clause.
    setBusy(false);
  };

  const profile = view?.node.profile ?? null;

  return (
    <SettingsPageContainer width="wide">
      {view && loadError === null ? null : (
        <OrbitDeviceSection view={view} loadError={loadError} onReload={() => void load()} />
      )}

      {view ? (
        <SettingsSection id="orbit-profile" title="Orbit profile">
          <SettingsRow
            title="Profile"
            description="Devices with the same profile share their workspaces."
            control={
              <Select
                value={profile ? String(profile.id) : ""}
                onValueChange={(next) => {
                  const chosen = view.profiles.find((entry) => String(entry.id) === next);
                  if (chosen && chosen.id !== profile?.id) void bindProfile({ id: chosen.id });
                }}
              >
                <SelectTrigger size="sm" aria-label="Profile" disabled={busy}>
                  <SelectValue>{profile?.name ?? "Choose a profile"}</SelectValue>
                </SelectTrigger>
                <SelectPopup align="end" alignItemWithTrigger={false}>
                  {view.profiles.map((entry) => (
                    <SelectItem key={entry.id} value={String(entry.id)}>
                      {entry.name}
                    </SelectItem>
                  ))}
                </SelectPopup>
              </Select>
            }
          />
          <SettingsRow
            title="New profile"
            description="Creates a profile and switches this device to it."
            control={
              <div className="flex items-center gap-2">
                <Input
                  aria-label="New profile name"
                  placeholder="Name"
                  value={newProfileName}
                  onChange={(event) => setNewProfileName(event.target.value)}
                />
                <Button
                  size="xs"
                  variant="outline"
                  disabled={newProfileName.trim() === "" || busy}
                  onClick={() => void bindProfile({ name: newProfileName.trim() })}
                >
                  Create
                </Button>
              </div>
            }
          />
        </SettingsSection>
      ) : null}

      {view ? <ProfileSyncSection profileName={profile?.name ?? null} /> : null}
    </SettingsPageContainer>
  );
}
