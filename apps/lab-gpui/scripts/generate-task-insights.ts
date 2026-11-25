// Run with Bun, then run `vp fmt apps/lab-gpui/src/mock/taskInsights.json` from the repo root.
import { fixtureOrbitTasksTransport } from "../../web/src/orbit/tasks/orbitTasksFixtures";
import { createOrbitTasksClient } from "../../../packages/client-runtime/src/orbitGateway/tasksClient";
import {
  INSIGHTS,
  INSIGHT_PERIODS,
  formatInsightValue,
  insightByProvider,
  insightChangeTone,
  insightProviderName,
  insightResults,
  insightTrend,
} from "../../../packages/client-runtime/src/orbitGateway/taskInsights";

const client = createOrbitTasksClient(fixtureOrbitTasksTransport());
const periods = await Promise.all(
  INSIGHT_PERIODS.map(async (period) => {
    const response = await client.getTaskInsights({ period });
    if (response.status !== "ok") throw new Error(response.message);
    const data = response.value;
    const results = insightResults(data);
    return [
      period,
      INSIGHTS.map((spec) => {
        const { value, change } = results[spec.id];
        const trend = insightTrend(data, spec.id) ?? [];
        return {
          id: spec.id,
          label: spec.label,
          value: value === null ? "–" : formatInsightValue(spec.id, value),
          change:
            change === null
              ? ""
              : (change > 0 ? "+" : change < 0 ? "−" : "±") +
                Math.abs(change) +
                (spec.unit === "pts" ? " pts" : spec.unit),
          tone: insightChangeTone(spec, change),
          providers: insightByProvider(data, spec.id).map(
            (p) =>
              insightProviderName(p.provider) +
              " " +
              (p.value === null ? "–" : formatInsightValue(spec.id, p.value)),
          ),
          points: trend.map((p) => ({
            date: p.date,
            value: p.value,
            label: formatInsightValue(spec.id, p.value),
          })),
        };
      }),
    ];
  }),
);
await Bun.write(
  new URL("../src/mock/taskInsights.json", import.meta.url),
  JSON.stringify(Object.fromEntries(periods)) + "\n",
);
