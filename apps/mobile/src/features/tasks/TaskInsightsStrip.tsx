import {
  formatInsightValue,
  INSIGHTS,
  insightChangeTone,
  insightResults,
  insightTrend,
  type InsightResult,
  type InsightSpec,
  type TrendPoint,
} from "@t3tools/client-runtime/orbit-gateway";
import { useGT, useMessages } from "gt-react-native";
import { ScrollView, View, useWindowDimensions } from "react-native";
import Svg, { Polyline } from "react-native-svg";
import { useResolveClassNames } from "uniwind";

import { AppText as Text } from "../../components/ui/AppText";
import { cn } from "../../lib/cn";
import { useOrbitTaskInsights } from "./orbitTasks";

const SPARK_HEIGHT = 28;

/** The insight over the period, where Orbit reports a history; other numbers have none yet. */
function Sparkline(props: { readonly points: ReadonlyArray<TrendPoint> }) {
  const { color } = useResolveClassNames("text-adaptive-sky-600-400");
  const values = props.points.flatMap((point) => (point.value === null ? [] : [point.value]));
  if (values.length < 2) return null;
  const min = Math.min(...values);
  const span = Math.max(...values) - min || 1;
  const last = props.points.length - 1;
  const points = props.points
    .flatMap((point, index) =>
      point.value === null
        ? []
        : [`${(index / last) * 100},${2 + (1 - (point.value - min) / span) * (SPARK_HEIGHT - 4)}`],
    )
    .join(" ");
  return (
    <Svg
      width="100%"
      height={SPARK_HEIGHT}
      viewBox={`0 0 100 ${SPARK_HEIGHT}`}
      preserveAspectRatio="none"
    >
      <Polyline
        points={points}
        fill="none"
        stroke={color}
        strokeWidth={1.5}
        strokeLinejoin="round"
        strokeLinecap="round"
        vectorEffect="non-scaling-stroke"
      />
    </Svg>
  );
}

function InsightCell(props: {
  readonly spec: InsightSpec;
  readonly result: InsightResult;
  readonly trend: ReadonlyArray<TrendPoint> | null;
  readonly width: number;
}) {
  const gt = useGT();
  const m = useMessages();
  const { spec, result } = props;
  const label = m(spec.label);
  const value = result.value === null ? null : formatInsightValue(spec.id, result.value, m);
  const tone = insightChangeTone(spec, result.change);
  const change =
    result.value === null || result.change === null
      ? null
      : `${result.change > 0 ? "+" : result.change < 0 ? "−" : "±"}${Math.abs(result.change)}${
          spec.unit === "pts" ? ` ${gt("pts", { $context: "share points" })}` : spec.unit
        }`;
  return (
    <View
      accessible
      accessibilityLabel={[label, value ?? gt("Not reported"), change].filter(Boolean).join(", ")}
      className="gap-1 border-r border-border px-4 py-3"
      style={{ width: props.width }}
    >
      <Text className="text-[13px] text-foreground-muted" numberOfLines={1}>
        {label}
      </Text>
      <View className="flex-row items-baseline gap-1.5">
        <Text
          className={cn(
            "text-[20px] leading-7 font-t3-medium tabular-nums",
            value === null ? "text-foreground-tertiary" : "text-foreground",
          )}
        >
          {value ?? "–"}
        </Text>
        {change === null ? null : (
          <Text
            className={cn(
              "text-[13px] tabular-nums",
              tone === "good"
                ? "text-adaptive-emerald-600-400"
                : tone === "bad"
                  ? "text-danger-foreground"
                  : "text-foreground-muted",
            )}
            numberOfLines={1}
          >
            {change}
          </Text>
        )}
      </View>
      {props.trend ? <Sparkline points={props.trend} /> : null}
    </View>
  );
}

/**
 * The board's insights above the Tasks list: the desktop's eight numbers as a strip of cells
 * divided by lines, swiped sideways. A number Orbit does not report, or a failed read, is a dash.
 */
export function TaskInsightsStrip() {
  const gt = useGT();
  const { width } = useWindowDimensions();
  const state = useOrbitTaskInsights("30d");
  const insights = state.status === "ok" ? state.value : null;
  const results = insightResults(insights);
  // Two cells and a part of the third show, so the strip reads as one you can swipe.
  const cellWidth = Math.round(width * 0.44);
  return (
    <View className="mb-2 border-y border-border">
      <ScrollView
        horizontal
        showsHorizontalScrollIndicator={false}
        snapToInterval={cellWidth}
        decelerationRate="fast"
        accessibilityLabel={gt("Task insights, last {days} days", { days: 30 })}
        accessibilityHint={
          state.status === "error"
            ? gt("Orbit did not answer: {message}", { message: state.message })
            : gt("Last {days} days against the {days} before.", { days: 30 })
        }
      >
        {INSIGHTS.map((spec) => (
          <InsightCell
            key={spec.id}
            spec={spec}
            result={results[spec.id]}
            trend={insightTrend(insights, spec.id)}
            width={cellWidth}
          />
        ))}
      </ScrollView>
    </View>
  );
}
