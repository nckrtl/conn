import {
  APPEARANCE_SECTION,
  DESKTOP_DEVICE_SECTION,
  type EnvironmentProvider,
  type OrbitGatewayClient,
  type OrbitGatewayEnvironment,
  type OrbitGatewayNode,
  type OrbitGatewayProfile,
  type ProfileSectionName,
} from "@t3tools/client-runtime/orbit-gateway";
import { useNavigate } from "@tanstack/react-router";
import { useEffect, useState } from "react";

import {
  connectOrbitEnvironment,
  setEnvironmentProvider,
  useEnvironmentProvider,
} from "~/orbit/environmentProvider";
import {
  desktopOrbitGatewayClient,
  forceOrbitProfileSync,
  syncOrbitProfileNow,
  useOrbitProfileSyncStatus,
} from "~/orbit/OrbitProfileSync";
import { useOrbitThreadStarts } from "~/orbit/orbitThreadStartStore";
import { backupLocalSections, restoreSectionBackup } from "~/orbit/profileSyncRegistry";
import {
  setGroupSyncEnabled,
  SYNC_GROUPS,
  useProfileSyncBackups,
  useProfileSyncOptOuts,
  type SyncGroup,
} from "~/orbit/profileSyncStorage";
import { useEnvironments } from "~/state/environments";

import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { Switch } from "../ui/switch";
import { toastManager } from "../ui/toast";
import { SettingsPageContainer, SettingsRow, SettingsSection } from "./settingsLayout";
import { searchableSetting, SETTINGS_SECTION_LABELS } from "./settingsSearch";
import { useMessages } from "gt-react";
import { useStableCallback } from "~/hooks/useStableCallback";

interface GatewayView {
  readonly node: OrbitGatewayNode;
  readonly profiles: readonly OrbitGatewayProfile[];
  readonly environments: readonly OrbitGatewayEnvironment[];
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
            ? "The T3 servers registered on the Orbit Gateway. Host servers pair automatically; connect a clone in the Orbit panel. Environments added here are switched off until you choose Default again."
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
 * This device's Node, its profiles and the Gateway's T3 servers, read on mount and after each
 * profile sync. Each Orbit panel page reads its own copy.
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
      const [node, profiles, environments] = await Promise.all([
        client.me(),
        client.profiles(),
        client.environments(),
      ]);
      setView({ node, profiles, environments });
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

/**
 * The Orbit panel's Connection page: this device's Node on the Gateway and the Gateway's T3
 * servers. Host servers pair automatically; a clone pairs when the user connects it.
 */
export function OrbitConnectionPage() {
  const { gateway, view, loadError, load } = useOrbitGatewayView();
  const { environments: savedEnvironments } = useEnvironments();
  const starts = useOrbitThreadStarts((state) => state.starts);
  const navigate = useNavigate();
  const m = useMessages();
  const connectionsLabel = m(SETTINGS_SECTION_LABELS["/settings/connections"]);

  const connected = new Set(
    savedEnvironments.map((environment) => String(environment.environmentId)),
  );
  const startingInstanceIds = new Set(
    // A stopped start waits for Retry; Connect may pair its clone meanwhile.
    starts.flatMap((start) =>
      start.instanceId === null || start.error !== null ? [] : [start.instanceId],
    ),
  );

  return (
    <SettingsPageContainer>
      <OrbitDeviceSection view={view} loadError={loadError} onReload={() => void load()} />

      {view ? (
        <SettingsSection id="orbit-servers" title="Orbit servers">
          {view.environments.length === 0 ? (
            <SettingsRow
              title="No servers registered"
              description="T3 servers register themselves with the Gateway."
            />
          ) : (
            view.environments.map((environment) => (
              <SettingsRow
                key={environment.environmentId}
                title={environment.label}
                description={environment.url.replace(/^https?:\/\//, "")}
                control={
                  <OrbitServerControl
                    gateway={gateway}
                    environment={environment}
                    connected={connected.has(environment.environmentId)}
                    starting={
                      environment.instanceId !== null &&
                      startingInstanceIds.has(environment.instanceId)
                    }
                  />
                }
              />
            ))
          )}
        </SettingsSection>
      ) : null}

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
 * profile sync. Until the Gateway answers it shows the device row, so a failure has its Reload.
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
    <SettingsPageContainer>
      {view ? null : (
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

/**
 * Conn: a Gateway server's state on this device. Host servers pair by themselves; a clone (an
 * Instance's server) pairs only when the user connects it here or this device started it.
 */
export function OrbitServerControl(props: {
  readonly gateway: OrbitGatewayClient | null;
  readonly environment: OrbitGatewayEnvironment;
  readonly connected: boolean;
  readonly starting: boolean;
}) {
  const { environment } = props;
  const [connecting, setConnecting] = useState(false);
  const status =
    environment.status === "session_expired"
      ? "Registration expired"
      : environment.powerState === "stopped"
        ? "Asleep"
        : props.connected
          ? "Paired"
          : environment.instanceId === null || props.starting || connecting
            ? "Pairing…"
            : null;
  if (status !== null) return <span className="text-ui text-muted-foreground">{status}</span>;

  const connect = async () => {
    if (!props.gateway) return;
    setConnecting(true);
    const paired = await connectOrbitEnvironment(props.gateway, environment);
    if (!paired) {
      toastManager.add({
        type: "error",
        title: "Orbit",
        description: `Conn could not pair with ${environment.label}.`,
      });
    }
    setConnecting(false);
  };
  return (
    <div className="flex items-center gap-2">
      <span className="text-ui text-muted-foreground">Not connected</span>
      <Button size="xs" variant="outline" disabled={!props.gateway} onClick={() => void connect()}>
        Connect
      </Button>
    </div>
  );
}
