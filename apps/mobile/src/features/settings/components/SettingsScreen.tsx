import { useNavigation, useRoute } from "@react-navigation/native";
import type { ReactNode } from "react";
import { View } from "react-native";

import type { AppBarProps } from "../../../components/ui/AppBar.types";
import { AppBar } from "../../../components/ui/AppBar";
import { ScreenContent as SettingsScreenContent } from "../../../components/ui/ScreenContent";
import { useWorkspaceTabs } from "../../layout/workspace/WorkspaceTabsContext";
import { useDeviceType } from "../../../native/native-layout-metrics";
import { useCompactWorkspaceTabs } from "../../layout/workspace/useSystemWorkspaceTabBar";
import { useSettingsPageBack } from "../useSettingsPageBack";
import { SETTINGS_OPENS_AS_SHEET, settingsSheetClosedState } from "../settings-sheet";
import { resetRootStack } from "../../../lib/root-stack-reset";
import {
  ScreenScrollViewBottomInset,
  ScreenScrollViewSurface,
} from "../../../components/ui/ScreenScrollView";

export { SettingsScreenContent };

export function SettingsScreen(
  props: Pick<
    AppBarProps,
    "title" | "actions" | "refresh" | "trailing" | "search" | "menus" | "guardBack"
  > & {
    readonly children: ReactNode;
    readonly workspaceRoot?: boolean;
  },
) {
  const route = useRoute();
  const workspace = useWorkspaceTabs();
  const deviceType = useDeviceType();
  const compactTabs = useCompactWorkspaceTabs();
  const navigation = useNavigation();
  const back = useSettingsPageBack();
  const cover = deviceType === "duo-folded";
  // Opened as a workspace tab, the Settings list has nothing to go back to.
  const workspaceRoot = props.workspaceRoot || (workspace !== null && route.name === "Settings");
  // iPhone: the Settings list leads its sheet, so it closes the sheet with every page in it.
  const closeSheet =
    SETTINGS_OPENS_AS_SHEET && route.name === "Settings"
      ? () => resetRootStack(navigation, settingsSheetClosedState)
      : undefined;

  const surfaceClassName = workspaceRoot || cover ? "bg-screen" : "bg-sheet";

  return (
    <View collapsable={false} className={`flex-1 ${surfaceClassName}`}>
      <AppBar
        title={props.title}
        actions={props.actions}
        refresh={props.refresh}
        search={props.search}
        trailing={props.trailing}
        menus={props.menus}
        onBack={workspaceRoot ? undefined : back}
        onClose={closeSheet}
        closeAccessibilityLabel={closeSheet ? "Close settings" : undefined}
        guardBack={props.guardBack}
        hideBottomBorder
      />
      <ScreenScrollViewBottomInset value={deviceType === "pad" || compactTabs ? 80 : 0}>
        <ScreenScrollViewSurface value={surfaceClassName}>
          <SettingsScreenContent>{props.children}</SettingsScreenContent>
        </ScreenScrollViewSurface>
      </ScreenScrollViewBottomInset>
    </View>
  );
}
