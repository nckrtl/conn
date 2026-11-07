import type { EnvironmentProvider } from "@t3tools/client-runtime/orbit-gateway";
import { useState } from "react";
import { ActivityIndicator, Pressable, TextInput, View } from "react-native";

import { SymbolView } from "../../components/ui/AppSymbol";
import { AppText as Text } from "../../components/ui/AppText";
import { Menu } from "../../components/ui/Menu";
import { ErrorBanner } from "../../components/ui/ErrorBanner";
import { useSavedRemoteConnections } from "../../state/use-remote-environment-registry";
import { ConnectionSheetButton } from "./OrbitSheetButton";
import { SettingsSection } from "../settings/components/SettingsSection";
import {
  chooseOrbitProfile,
  refreshOrbitGateway,
  setEnvironmentProvider,
  useOrbitGateway,
} from "./orbitGatewayStore";

const PROVIDER_OPTIONS: ReadonlyArray<{
  readonly provider: EnvironmentProvider;
  readonly label: string;
  readonly description: string;
}> = [
  {
    provider: "default",
    label: "Default",
    description: "Environments you add on this device.",
  },
  {
    provider: "orbit",
    label: "Orbit",
    description: "Servers from the Orbit Gateway, with your profile's workspaces.",
  },
];

/** Which provider supplies this device's environments, at the top of Settings › Environments. */
export function EnvironmentProviderPicker() {
  const gateway = useOrbitGateway();
  const [switching, setSwitching] = useState(false);
  const current =
    PROVIDER_OPTIONS.find((option) => option.provider === gateway.provider) ?? PROVIDER_OPTIONS[0]!;
  const disabled = switching || !gateway.providerLoaded;

  return (
    <SettingsSection>
      <View className="flex-row items-center gap-4 p-4">
        <View className="min-w-0 flex-1 gap-1">
          <Text className="text-lg text-foreground">Provider</Text>
          <Text className="text-sm leading-normal text-foreground-muted">
            {current.description}
          </Text>
        </View>
        {switching ? (
          <ActivityIndicator />
        ) : (
          <Menu
            accessible
            accessibilityRole="button"
            accessibilityLabel={`Environment provider: ${current.label}`}
            title="Environment provider"
            actions={PROVIDER_OPTIONS.map((option) => ({
              id: option.provider,
              title: option.label,
              state: option.provider === gateway.provider ? ("on" as const) : ("off" as const),
            }))}
            onPressAction={({ nativeEvent }) => {
              const next = PROVIDER_OPTIONS.find((option) => option.provider === nativeEvent.event);
              if (!next || next.provider === gateway.provider || disabled) return;
              setSwitching(true);
              void setEnvironmentProvider(next.provider).finally(() => setSwitching(false));
            }}
          >
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={`Environment provider: ${current.label}`}
              disabled={disabled}
              className="flex-row items-center gap-1.5"
            >
              <Text className="text-base text-foreground-muted">{current.label}</Text>
              <SymbolView name="chevron.down" size={14} tintColorClassName="accent-chevron" />
            </Pressable>
          </Menu>
        )}
      </View>
    </SettingsSection>
  );
}

/**
 * The Orbit side of Settings › Environments: this device's Node and profile on the Orbit Gateway,
 * the profile's workspaces (read-only here; the desktop edits them), and the Gateway's T3 servers,
 * which pair automatically.
 */
export function OrbitEnvironmentSections() {
  const gateway = useOrbitGateway();
  const { savedConnectionsById } = useSavedRemoteConnections();
  const [newProfileName, setNewProfileName] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);

  const connected = new Set(
    Object.values(savedConnectionsById).map((entry) => String(entry.environmentId)),
  );
  const profile = gateway.node?.profile ?? null;

  const run = async (key: string, action: () => Promise<unknown>) => {
    setBusy(key);
    setActionError(null);
    try {
      await action();
    } catch (error) {
      setActionError(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(null);
    }
  };

  return (
    <View className="gap-4">
      {gateway.error || actionError ? (
        <ErrorBanner message={actionError ?? gateway.error ?? ""} />
      ) : null}

      <SettingsSection title="This device">
        <View className="flex-row items-center gap-4 p-4">
          <SymbolView name="person.crop.circle" size={22} tintColorClassName="accent-icon" />
          <View className="min-w-0 flex-1 gap-1">
            <Text className="text-lg text-foreground">
              {gateway.node?.name ??
                (gateway.phase === "error" ? "Gateway unreachable" : "Connecting…")}
            </Text>
            <Text className="text-sm text-foreground-muted">
              {gateway.node
                ? `Signed in to gateway.orbit as ${gateway.node.wireguardIp}`
                : "gateway.orbit, over WireGuard"}
            </Text>
          </View>
          {gateway.phase === "loading" ? (
            <ActivityIndicator />
          ) : (
            <Pressable accessibilityLabel="Reload" onPress={() => void refreshOrbitGateway()}>
              <SymbolView name="arrow.clockwise" size={18} tintColorClassName="accent-icon" />
            </Pressable>
          )}
        </View>
      </SettingsSection>

      {gateway.node ? (
        <SettingsSection title="Profile">
          {gateway.profiles.map((entry, index) => (
            <Pressable
              key={entry.id}
              accessibilityRole="radio"
              accessibilityState={{ checked: profile?.id === entry.id, disabled: busy !== null }}
              disabled={busy !== null}
              onPress={() =>
                void run(`profile:${entry.id}`, () => chooseOrbitProfile({ id: entry.id }))
              }
              className={
                index === 0
                  ? "flex-row items-center gap-4 p-4"
                  : "flex-row items-center gap-4 border-t border-border-subtle p-4"
              }
            >
              <Text className="min-w-0 flex-1 text-lg text-foreground">{entry.name}</Text>
              {busy === `profile:${entry.id}` ? (
                <ActivityIndicator />
              ) : profile?.id === entry.id ? (
                <SymbolView name="checkmark" size={18} tintColorClassName="accent-icon" />
              ) : null}
            </Pressable>
          ))}
          <View
            className={
              gateway.profiles.length === 0
                ? "flex-row items-center gap-3 p-4"
                : "flex-row items-center gap-3 border-t border-border-subtle p-4"
            }
          >
            <TextInput
              accessibilityLabel="New profile name"
              autoCapitalize="words"
              className="min-w-0 flex-1 text-lg text-foreground"
              onChangeText={setNewProfileName}
              placeholder="New profile"
              returnKeyType="done"
              value={newProfileName}
            />
            <ConnectionSheetButton
              compact
              disabled={newProfileName.trim() === "" || busy !== null}
              icon="plus"
              label="Create"
              onPress={() =>
                void run("profile:new", async () => {
                  await chooseOrbitProfile({ name: newProfileName.trim() });
                  setNewProfileName("");
                })
              }
            />
          </View>
        </SettingsSection>
      ) : null}

      {profile ? (
        <SettingsSection title={`${profile.name}'s workspaces`}>
          {gateway.workspaces.length === 0 ? (
            <Text className="p-4 text-sm text-foreground-muted">
              No workspaces yet. Create them in T3 Code on the desktop.
            </Text>
          ) : (
            gateway.workspaces.map((workspace, index) => (
              <View
                key={workspace.id}
                className={
                  index === 0
                    ? "flex-row items-center gap-4 p-4"
                    : "flex-row items-center gap-4 border-t border-border-subtle p-4"
                }
              >
                <Text className="min-w-0 flex-1 text-lg text-foreground">{workspace.name}</Text>
                <Text className="text-sm text-foreground-muted">
                  {(workspace.projectRefs?.length ?? 0) === 1
                    ? "1 project"
                    : `${workspace.projectRefs?.length ?? 0} projects`}
                </Text>
              </View>
            ))
          )}
        </SettingsSection>
      ) : null}

      {gateway.node ? (
        <SettingsSection title="Servers">
          {gateway.environments.map((environment, index) => (
            <View
              key={environment.environmentId}
              className={
                index === 0
                  ? "flex-row items-center gap-4 p-4"
                  : "flex-row items-center gap-4 border-t border-border-subtle p-4"
              }
            >
              <View className="min-w-0 flex-1 gap-1">
                <Text className="text-lg text-foreground">{environment.label}</Text>
                <Text className="text-sm text-foreground-muted">
                  {environment.url.replace(/^https?:\/\//, "")}
                </Text>
              </View>
              <Text className="text-sm text-foreground-muted">
                {environment.status === "session_expired"
                  ? "Registration expired"
                  : connected.has(environment.environmentId)
                    ? "Paired"
                    : "Pairing…"}
              </Text>
            </View>
          ))}
        </SettingsSection>
      ) : null}
    </View>
  );
}
