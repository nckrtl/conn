import { gatewayText } from "@t3tools/client-runtime/orbit-gateway";
import { useNavigation } from "@react-navigation/native";
import { ScreenScrollView as ScrollView } from "../../components/ui/ScreenScrollView";
import { ActivityIndicator } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { SettingsRow } from "../settings/components/SettingsRow";
import { SettingsScreen } from "../settings/components/SettingsScreen";
import { SettingsSection } from "../settings/components/SettingsSection";
import { useOrbitGateway } from "./orbitGatewayStore";

/**
 * Settings › Orbit: the phone's Orbit page. Instances and Profile join Connection here once they
 * are built; until then the page lists only Connection.
 */
export function SettingsOrbitRouteScreen() {
  const insets = useSafeAreaInsets();
  const gateway = useOrbitGateway();
  const navigation = useNavigation();
  return (
    <SettingsScreen title="Orbit">
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
          <SettingsSection footer="Orbit shows here while this phone takes its environments from Orbit.">
            <SettingsRow
              icon={undefined}
              label="Connection"
              value={
                gateway.phase === "ready" && gatewayText(gateway.node?.wireguardIp) !== null
                  ? "Connected"
                  : undefined
              }
              valuePosition="trailing"
              onPress={() => navigation.navigate("SettingsOrbitConnection")}
            />
          </SettingsSection>
        ) : (
          <SettingsSection footer="Choose Orbit as the Provider to show its connection.">
            <SettingsRow
              icon="desktopcomputer"
              label="Environments"
              target="SettingsEnvironments"
            />
          </SettingsSection>
        )}
      </ScrollView>
    </SettingsScreen>
  );
}
