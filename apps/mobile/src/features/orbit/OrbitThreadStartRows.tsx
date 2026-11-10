import { useSyncExternalStore } from "react";
import { Pressable, View } from "react-native";

import { AppActivityIndicator } from "../../components/ui/AppActivityIndicator";
import { SymbolView } from "../../components/ui/AppSymbol";
import { AppText as Text } from "../../components/ui/AppText";
import { useOrbitGateway } from "./orbitGatewayStore";
import {
  dismissOrbitThreadStart,
  orbitThreadStartRow,
  orbitThreadStartStore,
  retryOrbitThreadStart,
} from "./orbitThreadStartStore";

/**
 * Conn: the thread starts in Orbit Projects still on their way, above the thread list. Each shows
 * its stage; a stopped one offers Retry, and every one can be dismissed.
 */
export function OrbitThreadStartRows() {
  const gateway = useOrbitGateway();
  const starts = useSyncExternalStore(
    orbitThreadStartStore.subscribe,
    orbitThreadStartStore.starts,
  );
  if (gateway.provider !== "orbit" || starts.length === 0) return null;
  return (
    <View
      accessibilityLabel="Orbit thread starts"
      className="mx-2 mb-2 overflow-hidden rounded-[20px] bg-grouped-card"
    >
      {starts.map((start, index) => {
        const row = orbitThreadStartRow(start);
        return (
          <View
            key={start.id}
            className={
              index === 0
                ? "flex-row items-center gap-3 px-4 py-3"
                : "flex-row items-center gap-3 border-t border-border-subtle px-4 py-3"
            }
          >
            <View className="size-6 items-center justify-center">
              {row.stage === "stopped" ? (
                <SymbolView
                  name="exclamationmark.triangle"
                  size={16}
                  tintColorClassName="accent-warning-foreground"
                />
              ) : (
                <AppActivityIndicator colorClassName="accent-icon-muted" />
              )}
            </View>
            <View className="min-w-0 flex-1 gap-0.5">
              <Text className="text-base text-foreground" numberOfLines={1}>
                {start.projectSlug}
                <Text className="text-base text-foreground-muted"> · {row.label}</Text>
              </Text>
              <Text className="text-xs leading-snug text-foreground-muted" numberOfLines={2}>
                {row.detail}
              </Text>
            </View>
            {row.stage === "stopped" ? (
              <Pressable
                accessibilityRole="button"
                accessibilityLabel="Retry"
                hitSlop={8}
                onPress={() => retryOrbitThreadStart(start.id)}
              >
                <SymbolView name="arrow.clockwise" size={17} tintColorClassName="accent-icon" />
              </Pressable>
            ) : null}
            <Pressable
              accessibilityRole="button"
              accessibilityLabel="Dismiss"
              hitSlop={8}
              onPress={() => dismissOrbitThreadStart(start.id)}
            >
              <SymbolView name="xmark" size={15} tintColorClassName="accent-icon-muted" />
            </Pressable>
          </View>
        );
      })}
    </View>
  );
}
