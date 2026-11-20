import type { Icon } from "@tabler/icons-react-native";
/* Type-only import, erased at build: Metro never loads the package root for it. */
/* Package-root imports eagerly register the entire Tabler icon set in Metro. */
import IconAlarm from "@tabler/icons-react-native/IconAlarm";
import IconAlertCircle from "@tabler/icons-react-native/IconAlertCircle";
import IconBolt from "@tabler/icons-react-native/IconBolt";
import IconBrain from "@tabler/icons-react-native/IconBrain";
import IconCheck from "@tabler/icons-react-native/IconCheck";
import IconChevronDown from "@tabler/icons-react-native/IconChevronDown";
import IconChevronUp from "@tabler/icons-react-native/IconChevronUp";
import IconCircleDot from "@tabler/icons-react-native/IconCircleDot";
import IconClipboard from "@tabler/icons-react-native/IconClipboard";
import IconCopy from "@tabler/icons-react-native/IconCopy";
import IconDeviceDesktop from "@tabler/icons-react-native/IconDeviceDesktop";
import IconDeviceMobile from "@tabler/icons-react-native/IconDeviceMobile";
import IconDotsVertical from "@tabler/icons-react-native/IconDotsVertical";
import IconDownload from "@tabler/icons-react-native/IconDownload";
import IconEdit from "@tabler/icons-react-native/IconEdit";
import IconEye from "@tabler/icons-react-native/IconEye";
import IconFlask from "@tabler/icons-react-native/IconFlask";
import IconFolder from "@tabler/icons-react-native/IconFolder";
import IconFolderOpen from "@tabler/icons-react-native/IconFolderOpen";
import IconGitMerge from "@tabler/icons-react-native/IconGitMerge";
import IconHammer from "@tabler/icons-react-native/IconHammer";
import IconKeyboard from "@tabler/icons-react-native/IconKeyboard";
import IconKeyboardHide from "@tabler/icons-react-native/IconKeyboardHide";
import IconListCheck from "@tabler/icons-react-native/IconListCheck";
import IconLock from "@tabler/icons-react-native/IconLock";
import IconMail from "@tabler/icons-react-native/IconMail";
import IconMessage from "@tabler/icons-react-native/IconMessage";
import IconMessageDots from "@tabler/icons-react-native/IconMessageDots";
import IconMinus from "@tabler/icons-react-native/IconMinus";
import IconRobot from "@tabler/icons-react-native/IconRobot";
import IconSitemap from "@tabler/icons-react-native/IconSitemap";
import IconTerminal2 from "@tabler/icons-react-native/IconTerminal2";
import IconTool from "@tabler/icons-react-native/IconTool";
import IconWorld from "@tabler/icons-react-native/IconWorld";
import IconX from "@tabler/icons-react-native/IconX";
import type { AndroidSymbol, SFSymbol, SymbolViewProps } from "expo-symbols";
import { createElement } from "react";
import { StyleSheet, View } from "react-native";
import { withUniwind } from "uniwind";
import { ConnGlyph } from "./ConnGlyph";
import { CONN_GLYPH_BY_SF_NAME } from "./connGlyphs.generated";

// Conn: Android draws the same Superheroicons glyphs as iOS, by SF Symbol name (the icon
// set's manifest). Tabler stays only for names the set does not map yet.
const INTERIM_TABLER_BY_SF_NAME = {
  alarm: IconAlarm,
  checklist: IconListCheck,
  "ellipsis.bubble": IconMessageDots,
  "envelope.badge": IconMail,
  flask: IconFlask,
  flowchart: IconSitemap,
  "git.issue": IconCircleDot,
  robot: IconRobot,
  "tray.and.arrow.down": IconDownload,
} satisfies Record<string, Icon>;

// Material names pair with an iOS name; the iOS name's glyph wins. Tabler draws the pairs
// whose iOS name the set does not map yet.
const INTERIM_TABLER_BY_MATERIAL_NAME = {
  bolt: IconBolt,
  build: IconTool,
  chat: IconMessage,
  chat_bubble: IconMessage,
  check: IconCheck,
  close: IconX,
  construction: IconHammer,
  content_copy: IconCopy,
  content_paste: IconClipboard,
  desktop_windows: IconDeviceDesktop,
  edit: IconEdit,
  error: IconAlertCircle,
  folder: IconFolder,
  folder_open: IconFolderOpen,
  keyboard: IconKeyboard,
  keyboard_arrow_down: IconChevronDown,
  keyboard_arrow_up: IconChevronUp,
  keyboard_hide: IconKeyboardHide,
  lock: IconLock,
  more_vert: IconDotsVertical,
  merge: IconGitMerge,
  psychology: IconBrain,
  public: IconWorld,
  remove: IconMinus,
  smartphone: IconDeviceMobile,
  terminal: IconTerminal2,
  visibility: IconEye,
} satisfies Partial<Record<AndroidSymbol, Icon>>;

type ConnSymbolName = keyof typeof CONN_GLYPH_BY_SF_NAME | keyof typeof INTERIM_TABLER_BY_SF_NAME;

export type { SFSymbol } from "expo-symbols";
export type AppSymbolName =
  | ConnSymbolName
  | {
      ios: SFSymbol;
      android: keyof typeof INTERIM_TABLER_BY_MATERIAL_NAME;
    };

export type AppSymbolViewProps = Omit<SymbolViewProps, "name"> & { name: AppSymbolName };

export function isAppSymbolName(name: string): name is Extract<AppSymbolName, string> {
  return (
    Object.hasOwn(CONN_GLYPH_BY_SF_NAME, name) || Object.hasOwn(INTERIM_TABLER_BY_SF_NAME, name)
  );
}

function lookup<T>(table: Readonly<Record<string, T>>, name: string | undefined): T | undefined {
  return name !== undefined && Object.hasOwn(table, name) ? table[name] : undefined;
}

function AppSymbolView(props: AppSymbolViewProps) {
  const materialName = typeof props.name === "string" ? undefined : props.name.android;
  const sfSymbol = typeof props.name === "string" ? props.name : props.name.ios;
  const glyph = lookup(CONN_GLYPH_BY_SF_NAME, sfSymbol);
  const TablerIcon = glyph
    ? undefined
    : (lookup(INTERIM_TABLER_BY_SF_NAME, sfSymbol) ??
      lookup(INTERIM_TABLER_BY_MATERIAL_NAME, materialName));

  if (!glyph && !TablerIcon) {
    return props.fallback ?? null;
  }

  // react-native-svg applies style.transform to its inner path around (0,0), so a
  // rotated icon draws outside its box. Transform a wrapping View instead.
  const transformed = StyleSheet.flatten(props.style)?.transform !== undefined;
  const style = transformed ? undefined : props.style;
  const icon = glyph ? (
    <ConnGlyph
      glyph={glyph}
      accessibilityLabel={props.accessibilityLabel}
      color={props.tintColor ?? undefined}
      size={props.size}
      style={style}
      testID={props.testID}
    />
  ) : (
    createElement(TablerIcon!, {
      accessibilityLabel: props.accessibilityLabel,
      color: props.tintColor,
      size: props.size,
      strokeWidth: 2,
      style,
      testID: props.testID,
    })
  );
  return transformed ? <View style={props.style}>{icon}</View> : icon;
}

export const SymbolView = withUniwind(AppSymbolView);
