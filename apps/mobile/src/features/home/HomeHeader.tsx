import { Toolbar } from "../../components/ui/Toolbar";
import { NativeStackScreenOptions } from "../../native/StackHeader";
import { use, useCallback, useEffect, useRef } from "react";
import { useNavigation, type ParamListBase } from "@react-navigation/native";
import type { NativeStackNavigationProp } from "@react-navigation/native-stack";
import { Platform } from "react-native";
import type { SearchBarCommands } from "react-native-screens";
import { NativePrimaryColumnContext } from "../../native/v5-workspace-context";
import { useUniwindTheme } from "../../lib/useUniwindTheme";
import { useHardwareKeyboardCommand } from "../keyboard/hardwareKeyboardCommands";
import { withNativeGlassHeaderItem } from "../layout/native-glass-header-items";
import { useCreateNativeMailSearchToolbarItem } from "../layout/native-mail-search-toolbar";
import { useNativeMailSearchToolbar } from "../../native/use-native-mail-search-toolbar";
import { selectOrbitWorkspace, useOrbitGateway } from "../orbit/orbitGatewayStore";
import { buildHomeListFilterMenu } from "./home-list-filter-menu";
import { createSidebarHeaderItems } from "../threads/sidebar-native-header-items";
import type { HomeHeaderProps } from "./HomeHeader.types";
import { useAdaptiveWorkspaceLayout } from "../layout/AdaptiveWorkspaceLayout";
import { WorkspacePhoneBar } from "../workspace/WorkspacePhoneBar";
import { useWorkspacePhoneBar } from "../workspace/useWorkspacePhoneBar";

export type { HomeHeaderEnvironment } from "./HomeHeader.types";

export function HomeHeader(props: HomeHeaderProps) {
  const createNativeMailSearchToolbarItem = useCreateNativeMailSearchToolbarItem();
  const navigation = useNavigation<NativeStackNavigationProp<ParamListBase>>();
  const { layout, panes, togglePrimarySidebar } = useAdaptiveWorkspaceLayout();
  const usesNativeMailSearchToolbar = useNativeMailSearchToolbar();
  const deviceType = useDeviceType();
  const primaryColumn = use(NativePrimaryColumnContext);
  const sidebarHeader =
    Platform.OS === "ios" &&
    primaryColumn !== null &&
    (deviceType === "pad" || !usesNativeMailSearchToolbar);
  const showsCompactCompose = deviceType === "pad" && !layout.usesSplitView;
  const searchBarRef = useRef<SearchBarCommands>(null);
  const focusAfterReveal = useRef(false);
  useEffect(
    () =>
      navigation.addListener("transitionEnd", (event) => {
        if (focusAfterReveal.current && !event.data.closing) {
          focusAfterReveal.current = false;
          searchBarRef.current?.focus();
        }
      }),
    [navigation],
  );
  const iconColor = useUniwindTheme()["--color-icon"];
  // The list uses a fixed creation order and ignores sort/group options, so
  // the filter menu only carries the filters and the "customized" icon state
  // keys off those alone.
  const gateway = useOrbitGateway();
  const workspaces = gateway.workspaces.map((workspace) => ({
    id: workspace.id,
    label: workspace.name,
  }));
  const hasCustomListOptions =
    props.selectedEnvironmentId !== null ||
    props.selectedProjectKey !== null ||
    gateway.selectedWorkspaceId !== null;
  const focusSearch = useCallback(() => {
    if (primaryColumn && !panes.primarySidebarVisible) {
      focusAfterReveal.current = true;
      togglePrimarySidebar();
      return true;
    }
    searchBarRef.current?.focus();
    return searchBarRef.current !== null;
  }, [primaryColumn, panes.primarySidebarVisible, togglePrimarySidebar]);
  useHardwareKeyboardCommand("focusSearch", focusSearch);
  const filterMenu = buildHomeListFilterMenu({
    ...props,
    workspaces,
    selectedWorkspaceId: gateway.selectedWorkspaceId,
    onWorkspaceChange: selectOrbitWorkspace,
  });

  // Conn: on iPhone the thread filters sit inside the bottom bar's search field.
  const connPhoneBar = useWorkspacePhoneBar();
  if (props.usesWorkspaceToolbar) {
    return connPhoneBar ? (
      <WorkspacePhoneBar filterMenu={filterMenu} filterActive={hasCustomListOptions} />
    ) : null;
  }

  return (
    <>
      <NativeStackScreenOptions
        optionsVersion={[filterMenu.items, showsCompactCompose]}
        options={{
          headerTintColor: iconColor,
          // On iPhone, settings lives in the bottom bar; the header carries no items.
          unstable_headerRightItems: () =>
            sidebarHeader
              ? [
                  ...createSidebarHeaderItems({
                    filterIcon: hasCustomListOptions
                      ? "line.3.horizontal.decrease.circle.fill"
                      : "line.3.horizontal.decrease.circle",
                    filterMenu,
                    onOpenSettings: props.onOpenSettings,
                  }),
                  ...(showsCompactCompose
                    ? [
                        withNativeGlassHeaderItem({
                          accessibilityLabel: "New task",
                          axisBehavior: "horizontalOnly",
                          icon: { name: "square.and.pencil", type: "sfSymbol" } as const,
                          identifier: "home-new-task",
                          label: "",
                          onPress: props.onStartNewTask,
                          type: "button",
                        }),
                      ]
                    : []),
                ]
              : [],
          // The keys below are set per-branch (not `undefined`) so a later
          // reapply cannot clobber options owned by Toolbar.
          ...(sidebarHeader
            ? {
                headerSearchBarOptions: {
                  ref: searchBarRef,
                  autoCapitalize: "none" as const,
                  hideNavigationBar: false,
                  hideWhenScrolling: false,
                  obscureBackground: false,
                  placement: "stacked" as const,
                  allowToolbarIntegration: false,
                  placeholder: "Search",
                  onCancelButtonPress: () => props.onSearchQueryChange(""),
                  onChangeText: (event) => props.onSearchQueryChange(event.nativeEvent.text),
                },
                unstable_headerToolbarItems: () => [],
              }
            : usesNativeMailSearchToolbar
              ? {
                  headerSearchBarOptions: {
                    ref: searchBarRef,
                    autoCapitalize: "none" as const,
                    onCancelButtonPress: () => props.onSearchQueryChange(""),
                  },
                  // Bottom bar, left to right: settings, search with the filter
                  // inside its trailing edge, then create.
                  unstable_headerToolbarItems: () => [
                    withNativeGlassHeaderItem({
                      accessibilityLabel: "Open settings",
                      axisBehavior: "horizontalOnly",
                      icon: { name: "ellipsis", type: "sfSymbol" } as const,
                      identifier: "home-settings",
                      label: "",
                      onPress: props.onOpenSettings,
                      type: "button",
                    }),
                    createNativeMailSearchToolbarItem({
                      composeButtonId: "home-new-task",
                      composeSystemImageName: "plus",
                      // Conn: the filter sits inside the search field, not beside settings.
                      filterInsideSearch: true,
                      filterMenu,
                      filterButtonId: "home-filter",
                      filterSystemImageName: hasCustomListOptions
                        ? "line.3.horizontal.decrease.circle.fill"
                        : "line.3.horizontal.decrease",
                      onComposePress: props.onStartNewTask,
                      onSearchTextChange: props.onSearchQueryChange,
                      placeholder: "Search",
                      searchTextChangeId: "home-search-text",
                      showsSearchDismissButton: true,
                    }),
                  ],
                }
              : {
                  // Pre-Liquid-Glass iOS: standard pull-down search in the nav
                  // bar; settings, filter and create live in the plain bottom
                  // toolbar below.
                  headerSearchBarOptions: {
                    ref: searchBarRef,
                    autoCapitalize: "none" as const,
                    hideNavigationBar: false,
                    placeholder: "Search",
                    onCancelButtonPress: () => {
                      props.onSearchQueryChange("");
                    },
                    onChangeText: (event) => {
                      props.onSearchQueryChange(event.nativeEvent.text);
                    },
                  },
                }),
        }}
      />

      {sidebarHeader || usesNativeMailSearchToolbar ? null : (
        <Toolbar placement="bottom">
          <Toolbar.Button
            accessibilityLabel="Open settings"
            icon="ellipsis"
            onPress={props.onOpenSettings}
            separateBackground
          />
          <Toolbar.Spacer flexible />
          {/* The pull-down search lives in the nav bar here, so the filter
              cannot sit inside it; it stays beside the create button. */}
          <Toolbar.Menu
            accessibilityLabel="Filter threads"
            icon={
              hasCustomListOptions
                ? "line.3.horizontal.decrease.circle.fill"
                : "line.3.horizontal.decrease.circle"
            }
            title="Thread list options"
            separateBackground
          >
            {workspaces.length > 0 ? (
              <Toolbar.Menu title="Workspace">
                <Toolbar.Label>Workspace</Toolbar.Label>
                <Toolbar.MenuAction
                  isOn={gateway.selectedWorkspaceId === null}
                  onPress={() => selectOrbitWorkspace(null)}
                  subtitle="Show threads from every workspace"
                >
                  <Toolbar.Label>All projects</Toolbar.Label>
                </Toolbar.MenuAction>
                {workspaces.map((workspace) => (
                  <Toolbar.MenuAction
                    key={workspace.id}
                    isOn={gateway.selectedWorkspaceId === workspace.id}
                    onPress={() => selectOrbitWorkspace(workspace.id)}
                  >
                    <Toolbar.Label>{workspace.label}</Toolbar.Label>
                  </Toolbar.MenuAction>
                ))}
              </Toolbar.Menu>
            ) : null}

            <Toolbar.Menu title="Environment">
              <Toolbar.Label>Environment</Toolbar.Label>
              <Toolbar.MenuAction
                isOn={props.selectedEnvironmentId === null}
                onPress={() => props.onEnvironmentChange(null)}
                subtitle="Show threads from every environment"
              >
                <Toolbar.Label>All environments</Toolbar.Label>
              </Toolbar.MenuAction>
              {props.environments.map((environment) => (
                <Toolbar.MenuAction
                  key={environment.environmentId}
                  isOn={props.selectedEnvironmentId === environment.environmentId}
                  onPress={() => props.onEnvironmentChange(environment.environmentId)}
                >
                  <Toolbar.Label>{environment.label}</Toolbar.Label>
                </Toolbar.MenuAction>
              ))}
            </Toolbar.Menu>

            {props.projects.length > 0 ? (
              <Toolbar.Menu title="Project">
                <Toolbar.Label>Project</Toolbar.Label>
                <Toolbar.MenuAction
                  isOn={props.selectedProjectKey === null}
                  onPress={() => props.onProjectChange(null)}
                  subtitle="Show threads from every project"
                >
                  <Toolbar.Label>All projects</Toolbar.Label>
                </Toolbar.MenuAction>
                {props.projects.map((project) => (
                  <Toolbar.MenuAction
                    key={project.key}
                    isOn={props.selectedProjectKey === project.key}
                    onPress={() => props.onProjectChange(project.key)}
                    subtitle={project.subtitle}
                  >
                    <Toolbar.Label>{project.label}</Toolbar.Label>
                  </Toolbar.MenuAction>
                ))}
              </Toolbar.Menu>
            ) : null}
          </Toolbar.Menu>
          <Toolbar.Button
            accessibilityLabel="New task"
            icon="plus"
            onPress={props.onStartNewTask}
            separateBackground
          />
        </Toolbar>
      )}
    </>
  );
}
