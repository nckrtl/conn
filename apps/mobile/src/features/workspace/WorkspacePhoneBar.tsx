import { useFocusEffect, useNavigation } from "@react-navigation/native";
import { use, useCallback, useEffect, useRef } from "react";
import { Keyboard, Pressable, Text, View } from "react-native";
import type { SearchBarCommands } from "react-native-screens";

import { SymbolView } from "../../components/AppSymbol";
import { NativeStackScreenOptions } from "../../native/StackHeader";
import { NativeWorkspaceTabActivityContext } from "../../native/v5-workspace-context";
import type { HomeListFilterMenu } from "../home/home-list-filter-menu";
import { useHardwareKeyboardCommand } from "../keyboard/hardwareKeyboardCommands";
import { withNativeGlassHeaderItem } from "../layout/native-glass-header-items";
import { useCreateNativeMailSearchToolbarItem } from "../layout/native-mail-search-toolbar";
import { useWorkspaceTabs } from "./WorkspaceTabsContext";
import type { WorkspaceTab } from "./workspace-tabs-state";

const SWITCHER_ITEM_WIDTH = 64;
const SWITCHER_HEIGHT = 48;
const SWITCHER_PADDING = 3;

const SWITCHER_ITEMS = [
  { key: "threads", label: "Threads", accessibilityLabel: "Threads", icon: "text.bubble" },
  {
    key: "pullRequests",
    label: "Pulls",
    accessibilityLabel: "Pull requests",
    icon: "arrow.triangle.pull",
  },
  { key: "search", label: "Search", accessibilityLabel: "Search", icon: "magnifyingglass" },
] as const;

/** Threads, Pulls and Search share one glass group in the toolbar. */
function WorkspacePhoneSwitcher(props: {
  readonly selectedTab: WorkspaceTab;
  readonly onSelect: (tab: WorkspaceTab) => void;
  readonly onSearch: () => void;
}) {
  return (
    <View
      accessibilityRole="tablist"
      style={{
        flexDirection: "row",
        width: SWITCHER_ITEMS.length * SWITCHER_ITEM_WIDTH + SWITCHER_PADDING * 2,
        height: SWITCHER_HEIGHT,
        padding: SWITCHER_PADDING,
      }}
    >
      {SWITCHER_ITEMS.map((item) => {
        const selected = item.key === props.selectedTab;
        return (
          <Pressable
            key={item.key}
            accessibilityRole={item.key === "search" ? "button" : "tab"}
            accessibilityLabel={item.accessibilityLabel}
            accessibilityState={item.key === "search" ? undefined : { selected }}
            onPress={() => {
              if (item.key === "search") props.onSearch();
              else if (!selected) props.onSelect(item.key);
            }}
            className={selected ? "bg-subtle-strong" : undefined}
            style={{
              width: SWITCHER_ITEM_WIDTH,
              borderRadius: (SWITCHER_HEIGHT - SWITCHER_PADDING * 2) / 2,
              alignItems: "center",
              justifyContent: "center",
              gap: 1,
            }}
          >
            <SymbolView
              name={item.icon}
              size={19}
              tintColorClassName={selected ? "accent-focus" : "accent-icon"}
            />
            <Text
              className={
                selected
                  ? "text-3xs font-t3-medium text-foreground"
                  : "text-3xs font-t3-medium text-foreground-muted"
              }
              numberOfLines={1}
            >
              {item.label}
            </Text>
          </Pressable>
        );
      })}
    </View>
  );
}

/**
 * Conn's iPhone bottom bar: settings, the Threads / Pulls / Search group, and New chat.
 * Search swaps the group for the toolbar search field, with the filter menu inside it,
 * and searches the selected tab. Cancelling, or leaving the field empty, brings the group back.
 */
export function WorkspacePhoneBar(props: {
  readonly filterMenu?: HomeListFilterMenu;
  readonly filterActive?: boolean;
}) {
  const workspace = useWorkspaceTabs()!;
  const navigation = useNavigation();
  const createSearchItem = useCreateNativeMailSearchToolbarItem();
  const tabActive = use(NativeWorkspaceTabActivityContext)?.active ?? true;
  const searchRef = useRef<SearchBarCommands>(null);
  const { isTabActive } = workspace;
  const selectedTab = workspace.state.selectedTab;
  const tab = workspace.state.tabs[selectedTab];
  const searching = tab.searchMode !== "resting";

  const startSearch = useCallback(() => {
    if (!workspace.isTabActive(selectedTab)) return false;
    workspace.dispatch({
      type: "scroll",
      tab: selectedTab,
      offset: workspace.getScrollOffset(selectedTab),
    });
    workspace.dispatch({ type: "search", tab: selectedTab });
    searchRef.current?.focus();
    return true;
  }, [workspace, selectedTab]);
  useHardwareKeyboardCommand("focusSearch", startSearch);
  const endSearch = () => {
    workspace.recordScrollOffset(selectedTab, tab.searchEntryOffset);
    workspace.dispatch({ type: "cancel", tab: selectedTab });
  };

  // The native field is recreated when the screen returns; give it back its query.
  const restoreSearch = useCallback(() => {
    if (isTabActive(selectedTab) && tab.searchMode !== "resting")
      searchRef.current?.setText(tab.query);
  }, [isTabActive, selectedTab, tab.searchMode, tab.query]);
  useFocusEffect(
    useCallback(() => {
      const frame = requestAnimationFrame(restoreSearch);
      return () => cancelAnimationFrame(frame);
    }, [restoreSearch]),
  );
  useEffect(() => {
    if (!tabActive) return;
    const frame = requestAnimationFrame(restoreSearch);
    return () => cancelAnimationFrame(frame);
  }, [restoreSearch, tabActive]);

  const openNewTask = () => navigation.navigate("NewTaskSheet", { screen: "NewTask" });
  const settingsItem = withNativeGlassHeaderItem({
    accessibilityLabel: "Open settings",
    axisBehavior: "horizontalOnly",
    icon: { name: "ellipsis", type: "sfSymbol" } as const,
    identifier: "workspace-settings",
    label: "",
    onPress: () =>
      navigation.navigate("SettingsSheet", {
        screen: "SettingsContent",
        params: { screen: "Settings" },
      }),
    type: "button",
  });

  return (
    <NativeStackScreenOptions
      optionsVersion={[selectedTab, tab.searchMode, props.filterMenu?.items, props.filterActive]}
      options={{
        unstable_headerRightItems: () => [],
        headerSearchBarOptions: searching
          ? {
              ref: searchRef,
              autoFocus: tab.searchMode === "active",
              autoCapitalize: "none",
              onFocus: () => workspace.dispatch({ type: "search", tab: selectedTab }),
              onBlur: () => {
                if (tab.query.trim() === "") endSearch();
                else workspace.dispatch({ type: "expand", tab: selectedTab });
              },
              onSearchButtonPress: () => searchRef.current?.blur(),
              onCancelButtonPress: endSearch,
            }
          : undefined,
        unstable_headerToolbarItems: () =>
          searching
            ? [
                settingsItem,
                createSearchItem({
                  composeButtonId: "workspace-new-task",
                  composeSystemImageName: "plus",
                  filterInsideSearch: true,
                  filterMenu: props.filterMenu,
                  filterButtonId: "workspace-filter",
                  filterSystemImageName: props.filterActive
                    ? "line.3.horizontal.decrease.circle.fill"
                    : "line.3.horizontal.decrease",
                  onComposePress: openNewTask,
                  onSearchTextChange: (query) =>
                    workspace.dispatch({ type: "query", query, tab: selectedTab }),
                  placeholder:
                    selectedTab === "pullRequests" ? "Search pull requests" : "Search threads",
                  searchTextChangeId: "workspace-search-text",
                }),
              ]
            : [
                settingsItem,
                { type: "spacing", spacing: 8, flexible: true },
                {
                  type: "custom",
                  element: (
                    <WorkspacePhoneSwitcher
                      selectedTab={selectedTab}
                      onSelect={(next) => {
                        Keyboard.dismiss();
                        workspace.dispatch({ type: "select", tab: next });
                      }}
                      onSearch={startSearch}
                    />
                  ),
                },
                { type: "spacing", spacing: 8, flexible: true },
                withNativeGlassHeaderItem({
                  accessibilityLabel: "New chat",
                  axisBehavior: "horizontalOnly",
                  icon: { name: "plus", type: "sfSymbol" } as const,
                  identifier: "workspace-new-task",
                  label: "",
                  onPress: openNewTask,
                  type: "button",
                }),
              ],
      }}
    />
  );
}
