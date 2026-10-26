import { useNavigation, useRoute } from "@react-navigation/native";
import { use, type ComponentProps, type ReactNode } from "react";
import { Platform, View } from "react-native";
import { useResolveClassNames } from "uniwind";

import { SymbolView } from "../../../components/ui/AppSymbol";
import { ListRow } from "../../../components/ui/ListRow";
import { ListRowLayout } from "../../../components/ui/ListRowLayout";
import { RowPressable } from "../../../components/ui/RowPressable";
import { cn } from "../../../lib/cn";
import type { SettingsLegalDocumentTarget, SettingsPageTarget } from "./settings-page-targets";
import { SettingsSidebarContext } from "./SettingsSection";
import { openSettings } from "../settings-navigation";

export function SettingsRow(props: {
  readonly disabled?: boolean;
  readonly icon: ComponentProps<typeof ListRow>["icon"];
  /** Drawn in place of `icon`, for a mark that is not a symbol. */
  readonly leading?: ReactNode;
  readonly label: string;
  readonly value?: string;
  readonly valuePosition?: "below" | "trailing";
  readonly target?: SettingsPageTarget;
  readonly fullScreenTarget?: SettingsLegalDocumentTarget;
  readonly onPress?: () => void;
}) {
  const navigation = useNavigation();
  const sidebar = use(SettingsSidebarContext);
  // The Settings list opens pages in place of the detail column; a page's own rows push below.
  const inList = ["Home", "Settings"].includes(useRoute().name);
  const valueBelow =
    props.valuePosition === "below" ||
    (props.valuePosition === undefined && Platform.OS === "android");
  const content = {
    icon: props.icon,
    label: props.label,
    description: valueBelow ? props.value : undefined,
    detail: valueBelow ? undefined : props.value,
    disabled: props.disabled,
  };
  const onPress = () => {
    if (props.target) {
      if (inList) openSettings(navigation, props.target);
      else navigation.navigate(props.target);
    } else if (props.fullScreenTarget) {
      navigation.navigate(props.fullScreenTarget);
    } else {
      props.onPress?.();
    }
  };
  if (sidebar) {
    const selected = props.target !== undefined && props.target === sidebar.selected;
    return (
      <RowPressable
        accessibilityRole="button"
        accessibilityLabel={[props.label, props.value].filter(Boolean).join(", ")}
        accessibilityState={{ disabled: Boolean(props.disabled), selected }}
        disabled={props.disabled}
        onPress={onPress}
        className={cn("rounded-2xl", selected && "bg-subtle-strong")}
      >
        <ListRowLayout {...content} />
      </RowPressable>
    );
  }
  if (props.leading !== undefined && props.leading !== null) {
    return (
      <LeadingSettingsRow
        leading={props.leading}
        label={props.label}
        description={content.description}
        detail={content.detail}
        disabled={props.disabled}
        onPress={onPress}
      />
    );
  }
  return <ListRow {...content} onPress={onPress} />;
}

/**
 * ListRow with a custom leading mark (Conn: the Orbit ring) in the icon slot.
 * The mark takes the icon's 24pt box; ListRowLayout keeps the rest of the row.
 */
function LeadingSettingsRow(props: {
  readonly leading: ReactNode;
  readonly label: string;
  readonly description?: string;
  readonly detail?: string;
  readonly disabled?: boolean;
  readonly onPress: () => void;
}) {
  const rippleStyle = useResolveClassNames("bg-subtle-strong");
  return (
    <RowPressable
      accessibilityRole="button"
      accessibilityLabel={[props.label, props.description, props.detail].filter(Boolean).join(", ")}
      accessibilityState={{ disabled: Boolean(props.disabled) }}
      disabled={props.disabled}
      onPress={props.onPress}
      android_ripple={{ color: rippleStyle.backgroundColor }}
      unstable_pressDelay={Platform.OS === "android" ? 50 : undefined}
      className="bg-grouped-card"
    >
      <View className="flex-row items-center pl-4">
        <View className={props.disabled ? "size-6 opacity-45" : "size-6"}>
          <View className="flex-1 items-center justify-center">{props.leading}</View>
        </View>
        {/* ListRowLayout pads 16pt where its icon gap is 12pt. */}
        <View className="-ml-1 min-w-0 flex-1">
          <ListRowLayout
            label={props.label}
            description={props.description}
            detail={props.detail}
            disabled={props.disabled}
            accessory={
              <SymbolView
                name="chevron.right"
                size={16}
                tintColorClassName="accent-chevron"
                type="monochrome"
                weight="semibold"
              />
            }
          />
        </View>
      </View>
    </RowPressable>
  );
}
