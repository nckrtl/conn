import {
  gatewayText,
  orbitNodeServers,
  renewalFailureText,
  type OrbitConnectionCheckState,
  type OrbitConnectionProbe,
  type OrbitGatewayEnvironment,
  type OrbitNodeState,
} from "@t3tools/client-runtime/orbit-gateway";
import { useEffect, useEffectEvent, useRef, useState, type ReactNode } from "react";
import { ActivityIndicator, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { SymbolView } from "../../components/ui/AppSymbol";
import { AppText as Text } from "../../components/ui/AppText";
import { ScreenScrollView as ScrollView } from "../../components/ui/ScreenScrollView";
import { useSavedRemoteConnections } from "../../state/use-remote-environment-registry";
import {
  ConnectionStatusDot,
  type ConnectionStatusDotState,
} from "../connection/ConnectionStatusDot";
import { SettingsRow } from "../settings/components/SettingsRow";
import { SettingsScreen } from "../settings/components/SettingsScreen";
import { SettingsSection } from "../settings/components/SettingsSection";
import { ConnectionSheetButton } from "./OrbitSheetButton";
import { orbitGatewayClient } from "./orbitGatewayClient";
import { useOrbitGateway, type OrbitGatewayState } from "./orbitGatewayStore";
import { phoneOrbitConnectionChecks } from "./orbitPhoneConnection";

const CHECK_LABELS: Record<OrbitConnectionCheckState, string> = {
  pass: "OK",
  fail: "Failed",
  checking: "Checking",
  not_checked: "Not checked",
};

const NODE_STATES: Record<
  OrbitNodeState,
  { readonly label: string; readonly dot: ConnectionStatusDotState }
> = {
  paired: { label: "Paired", dot: "connected" },
  pairing: { label: "Pairing…", dot: "available" },
  expired: { label: "Registration expired", dot: "connecting" },
  revoked: { label: "Revoked in Orbit", dot: "error" },
  renewal_interrupted: { label: "Renewal interrupted", dot: "connecting" },
  renewal_failed: { label: "Could not renew.", dot: "connecting" },
};

/**
 * The Gateway's answer to `me` (which runs the three checks) and its server list, read on open and
 * on Reload. It calls the Gateway itself and leaves the app's Orbit store alone.
 */
function useOrbitConnection() {
  const [probe, setProbe] = useState<OrbitConnectionProbe>({ status: "checking" });
  const [environments, setEnvironments] = useState<readonly OrbitGatewayEnvironment[] | null>(null);
  const latest = useRef(0);

  const read = async (run: number) => {
    const [me, servers] = await Promise.allSettled([
      orbitGatewayClient.me(),
      orbitGatewayClient.environments(),
    ]);
    if (run !== latest.current) return;
    setProbe(
      me.status === "fulfilled"
        ? { status: "ok", node: me.value }
        : { status: "error", error: me.reason },
    );
    setEnvironments(servers.status === "fulfilled" ? servers.value : null);
  };

  const load = () => {
    setProbe({ status: "checking" });
    void read(++latest.current);
  };

  const readOnOpen = useEffectEvent(() => void read(++latest.current));
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- reads the Orbit Gateway on mount; Reload reads it again
  useEffect(() => {
    readOnOpen();
    return () => {
      latest.current += 1;
    };
  }, []);

  return { probe, environments, load };
}

/**
 * Settings › Orbit › Connection: this phone's Node, the three checks of its connection to the
 * Gateway, and the Nodes that run a T3 server. Conn takes the connection from the phone's
 * WireGuard tunnel, so a failed check says what to fix outside Conn.
 */
export function SettingsOrbitConnectionRouteScreen() {
  const insets = useSafeAreaInsets();
  const gateway = useOrbitGateway();

  return (
    <SettingsScreen title="Connection">
      <ScrollView
        contentInsetAdjustmentBehavior="automatic"
        showsVerticalScrollIndicator={false}
        className="flex-1"
        contentContainerClassName="gap-6 px-5 pt-4"
        contentContainerStyle={{ paddingBottom: Math.max(insets.bottom, 18) + 18 }}
      >
        {!gateway.providerLoaded ? (
          <ActivityIndicator />
        ) : gateway.provider === "orbit" ? (
          <OrbitConnectionDetails gateway={gateway} />
        ) : (
          <SettingsSection>
            <InfoRow
              label="Orbit is off"
              description="Choose Orbit as the Provider in Settings › Environments."
            />
          </SettingsSection>
        )}

        <SettingsSection footer='Orbit is turned on and off with "Provider" in Settings › Environments.'>
          <SettingsRow icon="desktopcomputer" label="Environments" target="SettingsEnvironments" />
        </SettingsSection>
      </ScrollView>
    </SettingsScreen>
  );
}

function OrbitConnectionDetails({ gateway }: { readonly gateway: OrbitGatewayState }) {
  const { probe, environments, load } = useOrbitConnection();
  const { savedConnectionsById } = useSavedRemoteConnections();

  const node = probe.status === "ok" ? probe.node : null;
  const address = gatewayText(node?.wireguardIp);
  const checks = phoneOrbitConnectionChecks(probe);
  const nodes =
    environments === null
      ? null
      : orbitNodeServers({
          environments,
          paired: new Set(Object.keys(savedConnectionsById)),
          revoked: new Set(gateway.revokedEnvironmentIds),
          interruptedRenewals: new Set(gateway.interruptedRenewalIds),
          renewalFailed: new Map(
            Object.entries(gateway.renewalFailed).map(([id, failure]) => [id, failure.reason]),
          ),
          device: node,
        });

  return (
    <>
      <SettingsSection footer="This phone reaches Orbit through its WireGuard tunnel. Conn has no Gateway setting.">
        <InfoRow
          label={gatewayText(node?.name) ?? "This phone"}
          description={
            address !== null
              ? `gateway.orbit · ${address}`
              : probe.status === "checking"
                ? "Connecting to gateway.orbit…"
                : undefined
          }
          trailing={
            <ConnectionSheetButton
              compact
              icon="arrow.clockwise"
              label="Reload"
              disabled={probe.status === "checking"}
              onPress={load}
            />
          }
        />
      </SettingsSection>

      <SettingsSection>
        {checks.map((check, index) => (
          <InfoRow
            key={check.key}
            first={index === 0}
            label={check.label}
            // A passed check needs no explanation; the others say what to do.
            description={check.state === "pass" ? undefined : check.message}
            trailing={<CheckState state={check.state} />}
          />
        ))}
      </SettingsSection>

      <SettingsSection
        title="Nodes"
        footer="The Nodes that run a T3 server. Conn pairs with them automatically."
      >
        {nodes === null ? (
          <InfoRow
            label={probe.status === "checking" ? "Loading…" : "Nodes not available"}
            description={
              probe.status === "checking"
                ? "Reading the Nodes from gateway.orbit."
                : probe.status === "ok"
                  ? "The Gateway did not send its list of servers. Reload to try again."
                  : "The Nodes show once the Gateway answers. Reload to try again."
            }
          />
        ) : nodes.length === 0 ? (
          <InfoRow
            label="No Nodes yet"
            description="A Node's T3 server registers itself with the Gateway."
          />
        ) : (
          nodes.map((entry, index) => {
            const status = NODE_STATES[entry.state];
            const description = [
              entry.isThisDevice ? "This phone" : null,
              gatewayText(entry.address),
            ]
              .filter(Boolean)
              .join(" · ");
            return (
              <InfoRow
                key={entry.environmentId}
                first={index === 0}
                leading={<ConnectionStatusDot state={status.dot} pulse={false} />}
                label={entry.name || "Unnamed Node"}
                description={description}
                status={
                  entry.renewalFailure === null
                    ? status.label
                    : renewalFailureText(entry.renewalFailure)
                }
              />
            );
          })
        )}
      </SettingsSection>
    </>
  );
}

function InfoRow(props: {
  readonly label: string;
  readonly description?: string;
  readonly status?: string;
  readonly leading?: ReactNode;
  readonly trailing?: ReactNode;
  readonly first?: boolean;
}) {
  return (
    <View
      className={
        props.first === false
          ? "flex-row items-center gap-3 border-t border-border-subtle p-4"
          : "flex-row items-center gap-3 p-4"
      }
    >
      {props.leading}
      <View className="min-w-0 flex-1 gap-1">
        <Text className="text-lg text-foreground">{props.label}</Text>
        {props.description ? (
          <Text className="text-sm leading-normal text-foreground-muted">{props.description}</Text>
        ) : null}
        {props.status ? (
          <Text className="text-sm leading-normal text-foreground-muted">{props.status}</Text>
        ) : null}
      </View>
      {props.trailing}
    </View>
  );
}

function CheckState(props: { readonly state: OrbitConnectionCheckState }) {
  return (
    <View className="flex-row items-center gap-1.5">
      {props.state === "checking" ? (
        <ActivityIndicator size="small" />
      ) : props.state === "pass" ? (
        <SymbolView name="checkmark" size={14} tintColorClassName="accent-icon" weight="semibold" />
      ) : props.state === "fail" ? (
        <SymbolView
          name="xmark"
          size={14}
          tintColorClassName="accent-danger-foreground"
          weight="semibold"
        />
      ) : null}
      <Text
        className={
          props.state === "fail"
            ? "text-sm text-danger-foreground"
            : "text-sm text-foreground-muted"
        }
      >
        {CHECK_LABELS[props.state]}
      </Text>
    </View>
  );
}
