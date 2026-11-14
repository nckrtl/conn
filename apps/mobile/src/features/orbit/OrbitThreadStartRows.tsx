import type { OrbitSetupCreateRow } from "@t3tools/client-runtime/orbit-gateway";
import { useSyncExternalStore } from "react";
import { Pressable, View } from "react-native";

import { AppActivityIndicator } from "../../components/ui/AppActivityIndicator";
import { SymbolView } from "../../components/ui/AppSymbol";
import { AppText as Text } from "../../components/ui/AppText";
import { useOrbitGateway } from "./orbitGatewayStore";
import { retryOrbitCompletion } from "./orbitThreadStartRuntime";
import {
  dismissOrbitThreadStart,
  orbitThreadStartRow,
  orbitThreadStartStore,
  retryOrbitThreadStart,
} from "./orbitThreadStartStore";

/**
 * Conn: the thread starts in Orbit Projects still on their way, above the thread list. Each shows
 * its stage; a stopped one offers Retry unless a Retry would fail the same way, and every one can
 * be dismissed. After the send a row follows the create's completion with the desktop card's rows
 * and words, and goes once the Instance is ready.
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
              index === 0 ? "gap-2 px-4 py-3" : "gap-2 border-t border-border-subtle px-4 py-3"
            }
          >
            <View className="flex-row items-center gap-3">
              <View className="size-6 items-center justify-center">
                {row.stage === "stopped" || row.stage === "setupFailed" ? (
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
                <Text className="text-base text-foreground" numberOfLines={2}>
                  {start.projectSlug}
                  <Text className="text-base text-foreground-muted"> · {row.label}</Text>
                </Text>
                <Text className="text-xs leading-snug text-foreground-muted" numberOfLines={2}>
                  {row.detail}
                </Text>
                {row.notes.map((note) => (
                  <Text key={note} className="text-xs leading-snug text-foreground-muted">
                    {note}
                  </Text>
                ))}
              </View>
              {row.canRetry ? (
                <Pressable
                  accessibilityRole="button"
                  accessibilityLabel="Retry"
                  hitSlop={8}
                  onPress={() =>
                    row.stage === "setupFailed"
                      ? retryOrbitCompletion(start.id)
                      : retryOrbitThreadStart(start.id)
                  }
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
            {row.rows ? <OrbitCreateRows rows={row.rows} /> : null}
          </View>
        );
      })}
    </View>
  );
}

/** The desktop card's rows under "Create Instance": done, running, failed or not started yet. */
function OrbitCreateRows({ rows }: { rows: readonly OrbitSetupCreateRow[] }) {
  return (
    <View className="ml-9 gap-1.5">
      {rows.map((row) => (
        <View
          key={row.id}
          accessibilityLabel={row.label}
          className="flex-row items-center gap-2"
          testID={`orbit-create-row-${row.id}-${row.status}`}
        >
          <View className="size-4 items-center justify-center">
            {row.status === "running" ? (
              <AppActivityIndicator size="small" colorClassName="accent-icon-muted" />
            ) : row.status === "done" ? (
              <SymbolView name="checkmark" size={12} tintColorClassName="accent-icon-muted" />
            ) : row.status === "failed" ? (
              <SymbolView name="xmark" size={12} tintColorClassName="accent-warning-foreground" />
            ) : (
              <SymbolView name="circle" size={10} tintColorClassName="accent-icon-muted" />
            )}
          </View>
          <Text
            className={
              row.status === "pending" ? "text-sm text-foreground-muted" : "text-sm text-foreground"
            }
          >
            {row.label}
          </Text>
        </View>
      ))}
    </View>
  );
}
