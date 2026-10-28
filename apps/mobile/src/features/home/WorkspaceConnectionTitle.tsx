import type { NativeStackNavigationOptions } from "@react-navigation/native-stack";
import { createContext, use, useEffect, useState, type ReactNode } from "react";
import { Animated, AppState, Platform, Pressable, View } from "react-native";

import { AppActivityIndicator } from "../../components/ui/AppActivityIndicator";
import { SymbolView } from "../../components/ui/AppSymbol";
import { AppText as Text } from "../../components/ui/AppText";
import { useAndroidControlSizing } from "../../components/ui/useAndroidControlSizing";
import {
  brandTitleOffset,
  CompactBrandTitle,
  getCompactBrandHeaderOptions,
} from "../../components/CompactBrandTitle";
import { useDeadlinePassed } from "../../lib/clock";
import { useWorkspaceState } from "../../state/workspace";
import {
  workspaceConnectionStatusPresentation,
  type WorkspaceConnectionStatusPresentation,
} from "./workspace-connection-status";

const STATUS_SHOW_DELAY_MS = 800;
const FADE_IN_MS = 250;

type ConnectionStatus = WorkspaceConnectionStatusPresentation & {
  /** Only while the status first appears. A header that shows it later shows it at once. */
  readonly fadeIn: boolean;
};

const ConnectionStatusContext = createContext<ConnectionStatus | null>(null);

/**
 * The delay hides brief reconnects, so it is the workspace's, not each header's: every header
 * shows the status from the same moment. Headers read it from context instead of subscribing
 * themselves, because a hidden Android tab drops its subscriptions and showed a stale status for
 * a moment when it came back, while context still reaches it.
 */
export function WorkspaceConnectionStatusProvider(props: { readonly children: ReactNode }) {
  const { state } = useWorkspaceState();
  const presentation = workspaceConnectionStatusPresentation(state);
  const hasStatus = presentation !== null;
  // When the current status run began; a gap in the status restarts the delay.
  const [statusSince, setStatusSince] = useState(() => (hasStatus ? Date.now() : null));
  if (hasStatus !== (statusSince !== null)) {
    // oxlint-disable-next-line react/purity -- Reads the clock only in the render-phase adjustment that runs when the status appears.
    setStatusSince(hasStatus ? Date.now() : null);
  }
  const since = hasStatus ? statusSince : null;
  const fadeStarted = useDeadlinePassed(since === null ? null : since + STATUS_SHOW_DELAY_MS);
  const fadeEnded = useDeadlinePassed(
    since === null ? null : since + STATUS_SHOW_DELAY_MS + FADE_IN_MS,
  );

  const label = presentation?.label;
  const showsProgress = presentation?.showsProgress ?? false;
  const status =
    label === undefined || since === null || !fadeStarted
      ? null
      : { label, showsProgress, fadeIn: !fadeEnded };
  return <ConnectionStatusContext value={status}>{props.children}</ConnectionStatusContext>;
}

/**
 * Conn: connection status presentation, debounced for display, for a screen that shows it
 * outside a header: null until the workspace has been in a non-connected state for
 * STATUS_SHOW_DELAY_MS, then live-updating until the workspace reconnects (null again
 * immediately).
 */
export function useDelayedConnectionStatus(
  options: {
    /**
     * Keep the status hidden for this long after the app returns to the
     * foreground, so the reconnect that every resume triggers does not flash
     * it. Off by default.
     */
    readonly resumeGraceMs?: number;
  } = {},
): WorkspaceConnectionStatusPresentation | null {
  const { state } = useWorkspaceState();
  const presentation = workspaceConnectionStatusPresentation(state);
  const hasStatus = presentation !== null;
  const resumeGraceMs = options.resumeGraceMs ?? 0;
  const [visible, setVisible] = useState(false);
  const [resumedAt, setResumedAt] = useState(0);

  useEffect(() => {
    if (resumeGraceMs <= 0) return;
    const subscription = AppState.addEventListener("change", (next) => {
      if (next !== "active") return;
      setResumedAt(Date.now());
    });
    return () => subscription.remove();
  }, [resumeGraceMs]);

  useEffect(() => {
    // A resume restarts the delay, so a status already showing is withdrawn
    // and only returns if the connection is still down after the grace.
    setVisible(false);
    if (!hasStatus) return;
    const sinceResume = Date.now() - resumedAt;
    const delay = Math.max(STATUS_SHOW_DELAY_MS, resumeGraceMs - sinceResume);
    const timer = setTimeout(() => setVisible(true), delay);
    return () => clearTimeout(timer);
  }, [hasStatus, resumedAt, resumeGraceMs]);

  return visible ? presentation : null;
}

/**
 * Deliberately JS-driven: this can mount inside a native header item
 * (RNSScreenStackHeaderSubview), where native-driver animated nodes blank the
 * re-hosted view entirely. The JS driver updates opacity through the ordinary
 * style path, which those subviews handle.
 */
function StatusFadeIn(props: {
  readonly children: ReactNode;
  readonly animate: boolean;
  readonly grow?: boolean;
  readonly maxWidth?: number;
}) {
  const { animate } = props;
  const [opacity] = useState(() => new Animated.Value(0));
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- runs the Animated opacity fade-in and stops it on cleanup
  useEffect(() => {
    if (!animate) return;
    const animation = Animated.timing(opacity, {
      duration: FADE_IN_MS,
      toValue: 1,
      useNativeDriver: false,
    });
    animation.start();
    return () => animation.stop();
  }, [animate, opacity]);

  return (
    <Animated.View
      style={[
        {
          alignItems: "center",
          flexDirection: "row",
          maxWidth: props.maxWidth,
          // A hidden tab never runs the fade, so its value would still be 0 when the tab returns.
          opacity: animate ? opacity : 1,
        },
        props.grow ? { flex: 1, minWidth: 0 } : null,
      ]}
    >
      {props.children}
    </Animated.View>
  );
}

export function WorkspaceConnectionTitle(props: {
  readonly brand: ReactNode;
  readonly onPress?: () => void;
  readonly grow?: boolean;
  readonly size?: "navbar" | "pageTitle";
  readonly statusOffset?: number;
  readonly maxWidth?: number;
  /** Conn: presentation to show instead of the workspace's shared status; it fades in. */
  readonly status?: WorkspaceConnectionStatusPresentation | null;
}) {
  const sharedStatus = use(ConnectionStatusContext);
  const status: ConnectionStatus | null =
    props.status === undefined
      ? sharedStatus
      : props.status === null
        ? null
        : { ...props.status, fadeIn: true };
  const size = props.size ?? "navbar";
  const { scale } = useAndroidControlSizing();

  if (status === null) {
    return props.grow ? (
      <View style={{ alignItems: "center", flex: 1, flexDirection: "row", minWidth: 0 }}>
        {props.brand}
      </View>
    ) : (
      <>{props.brand}</>
    );
  }

  return (
    <StatusFadeIn animate={status.fadeIn} grow={props.grow} maxWidth={props.maxWidth}>
      <Pressable
        accessibilityHint="Opens environment settings"
        accessibilityLabel={status.label}
        accessibilityRole="button"
        disabled={props.onPress === undefined}
        hitSlop={8}
        onPress={props.onPress}
        className="flex-row items-center gap-2"
        style={[
          { flexShrink: 1, marginLeft: props.statusOffset ?? 0 },
          Platform.OS === "android" && { gap: 7 * scale },
        ]}
      >
        {status.showsProgress ? (
          <AppActivityIndicator
            colorClassName={"accent-icon-muted"}
            size={Platform.OS === "android" ? Math.round(20 * scale) : "small"}
          />
        ) : (
          <SymbolView
            name="wifi.slash"
            size={Math.round((size === "pageTitle" ? 17 : 15) * scale)}
            tintColorClassName={"accent-icon-muted"}
            type="monochrome"
          />
        )}
        <Text
          className="font-t3-semibold text-foreground-muted"
          numberOfLines={1}
          style={{ flexShrink: 1, fontSize: (size === "pageTitle" ? 20 : 16) * scale }}
        >
          {status.label}
        </Text>
      </Pressable>
    </StatusFadeIn>
  );
}

/**
 * Home header without the brand lockup: the title slot is empty while
 * connected and only shows the connection status while an environment is
 * unavailable. The header itself stays mounted because the native bottom
 * toolbar is attached to it.
 */
export function getConnectionStatusOnlyHeaderOptions(opts: {
  readonly headerWidth: number;
  readonly onOpenEnvironments: () => void;
}): NativeStackNavigationOptions {
  // No trailing header actions remain, so only bar margins and title spacing
  // limit the status label.
  const maxWidth = Math.max(0, opts.headerWidth - 64);

  return {
    headerTitle: () => (
      <WorkspaceConnectionTitle
        brand={null}
        maxWidth={maxWidth}
        onPress={opts.onOpenEnvironments}
        statusOffset={brandTitleOffset()}
      />
    ),
    title: "",
    unstable_headerLeftItems: undefined,
  };
}

/**
 * getCompactBrandHeaderOptions with the brand slot upgraded to the
 * connection-status swap. Screens with an environment-settings callback apply
 * this over the static brand options at mount.
 */
export function getConnectionAwareBrandHeaderOptions(opts: {
  readonly headerWidth: number;
  readonly trailingItemCount?: number;
  readonly onOpenEnvironments: () => void;
  readonly fallbackTitleStyle?: NativeStackNavigationOptions["headerTitleStyle"];
}): NativeStackNavigationOptions {
  const maxWidth = Math.max(0, opts.headerWidth - 64 - 44 * (opts.trailingItemCount ?? 1));

  return {
    ...getCompactBrandHeaderOptions(opts.fallbackTitleStyle),
    headerTitle: () => (
      <WorkspaceConnectionTitle
        brand={<CompactBrandTitle />}
        maxWidth={maxWidth}
        onPress={opts.onOpenEnvironments}
        statusOffset={brandTitleOffset()}
      />
    ),
  };
}
