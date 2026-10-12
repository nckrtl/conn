import { Platform } from "react-native";

import { NATIVE_LIQUID_GLASS_SUPPORTED } from "../../native/native-glass";
import { useNativeLayoutMetrics } from "../../native/native-layout-metrics";

/** Conn: iPhones use WorkspacePhoneBar in the bottom toolbar instead of UIKit's tab bar. */
export function useWorkspacePhoneBar() {
  const metrics = useNativeLayoutMetrics();
  return (
    Platform.OS === "ios" &&
    !Platform.isPad &&
    NATIVE_LIQUID_GLASS_SUPPORTED &&
    (metrics?.verticalBarEdge ?? "none") === "none"
  );
}
