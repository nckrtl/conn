import { useId, useRef, useState, type CSSProperties } from "react";
import snapshots from "./taskInsights.json";
import { Tool } from "./Icon";
import "./TaskInsights.css";

export const periods = {
  "24h": "Last 24 hours",
  "7d": "Last 7 days",
  "30d": "Last 30 days",
} as const;
export type Period = keyof typeof periods;
export const metricOptions = snapshots["30d"].map(({ id, label }) => ({ id, label }));
type Metric = (typeof snapshots)["30d"][number];

function Change({ metric }: { metric: Metric }) {
  if (!metric.change) return null;
  const direction = metric.change.startsWith("−")
    ? "down"
    : metric.change.startsWith("+")
      ? "up"
      : undefined;
  return (
    <span className="board-metric-change" data-tone={metric.tone}>
      {direction && <i aria-hidden="true" data-direction={direction} />}
      {metric.change}
    </span>
  );
}

function MetricSummary({ metric, expanded = false }: { metric: Metric; expanded?: boolean }) {
  return (
    <>
      <span className="board-metric-label">{metric.label}</span>
      <span className="board-metric-summary">
        <strong>{metric.value}</strong>
        <Change metric={metric} />
        {expanded && <small>{metric.providers.join(" · ")}</small>}
      </span>
    </>
  );
}

function Trend({ metric, expanded = false }: { metric: Metric; expanded?: boolean }) {
  const [hover, setHover] = useState<number | null>(null);
  const gradient = useId();
  const points = metric.points;
  if (!points.length)
    return expanded ? <div>Orbit reports no history for this number yet.</div> : null;
  const values = points.map((point) => point.value);
  const low = Math.min(...values),
    high = Math.max(...values);
  const x = (i: number) => 1 + (98 * i) / Math.max(1, points.length - 1);
  const y = (v: number) => (high === low ? 50 : 92 - (84 * (v - low)) / (high - low));
  const line = points.map((p, i) => x(i) + "," + y(p.value)).join(" ");
  const inspected = hover === null ? null : points[hover];
  const displayDate = (date: string) => (date.includes("T") ? date.slice(11, 16) : date.slice(5));
  return (
    <div className={expanded ? "board-insight-chart" : "board-insight-spark"}>
      <svg
        role={expanded ? "img" : undefined}
        aria-label={expanded ? metric.label + " trend" : undefined}
        aria-hidden={!expanded}
        viewBox="0 0 100 100"
        preserveAspectRatio="none"
        onPointerMove={
          expanded
            ? (event) => {
                const box = event.currentTarget.getBoundingClientRect();
                setHover(
                  Math.max(
                    0,
                    Math.min(
                      points.length - 1,
                      Math.round(((event.clientX - box.left) / box.width) * (points.length - 1)),
                    ),
                  ),
                );
              }
            : undefined
        }
        onPointerLeave={expanded ? () => setHover(null) : undefined}
      >
        <defs>
          <linearGradient id={gradient} x1="0" y1="0" x2="0" y2="1">
            {/* Both charts fade the same neutral muted colour (`SERIES_AREA_OPACITY`). */}
            <stop stopColor="var(--native-mutedForeground)" stopOpacity=".22" />
            <stop offset="100%" stopColor="var(--native-mutedForeground)" stopOpacity="0" />
          </linearGradient>
        </defs>
        {expanded &&
          [8, 50, 92].map((level) => (
            <line
              key={level}
              x1="0"
              x2="100"
              y1={level}
              y2={level}
              stroke="currentColor"
              opacity=".25"
              strokeDasharray="3 3"
              vectorEffect="non-scaling-stroke"
            />
          ))}
        <polygon points={`1,100 ${line} 99,100`} fill={`url(#${gradient})`} />
        <polyline
          points={line}
          fill="none"
          stroke="currentColor"
          strokeWidth={expanded ? 2 : 1.5}
          vectorEffect="non-scaling-stroke"
          strokeLinejoin="round"
        />
        {expanded && hover !== null && (
          <line
            x1={x(hover)}
            x2={x(hover)}
            y1="0"
            y2="100"
            stroke="currentColor"
            vectorEffect="non-scaling-stroke"
          />
        )}
      </svg>
      {expanded && (
        <>
          <div className="board-chart-scale" aria-hidden="true">
            <span>{points[values.indexOf(high)]?.label}</span>
            {high !== low && <span>{points[values.indexOf(low)]?.label}</span>}
          </div>
          <div className="board-chart-axis">
            <span>{displayDate(points[0]!.date)}</span>
            <span>{displayDate(points.at(-1)!.date)}</span>
          </div>
          {inspected && (
            <output className="board-chart-readout">
              {displayDate(inspected.date)} · {inspected.label}
            </output>
          )}
        </>
      )}
    </div>
  );
}

export function TaskInsights({ period, hidden }: { period: Period; hidden: readonly string[] }) {
  const [open, setOpen] = useState<string | null>(null);
  const trigger = useRef<HTMLButtonElement | null>(null);
  const cards = snapshots[period].filter((card) => !hidden.includes(card.id));
  const selected = cards.find((card) => card.id === open);
  const columns = cards.length <= 2 ? cards.length : Math.ceil(cards.length / 2);
  if (!cards.length) return null;
  function close() {
    setOpen(null);
    requestAnimationFrame(() => trigger.current?.focus({ preventScroll: true }));
  }
  return (
    <section className="board-insights" aria-label="Task insights">
      <div className="board-insights-scroll" inert={!!selected}>
        <div
          className="board-insights-grid"
          style={
            {
              gridTemplateColumns: `repeat(${columns}, minmax(130px,1fr))`,
              // A lone row stretches to 210px, so its sparklines take 42px more.
              "--spark-height": cards.length <= 2 ? "70px" : "53.75px",
            } as CSSProperties
          }
        >
          {cards.map((card, i) => (
            <button
              key={card.id}
              type="button"
              data-column-divider={i % columns !== 0 || undefined}
              data-row-divider={i >= columns || undefined}
              data-tip={[periods[period], ...card.providers].join(" · ")}
              aria-label={card.label + ", " + card.value + " · " + periods[period]}
              style={{
                gridColumn:
                  i === cards.length - 1 && cards.length > 2
                    ? "span " + (2 * columns - cards.length + 1)
                    : undefined,
              }}
              onClick={(event) => {
                trigger.current = event.currentTarget;
                setOpen(card.id);
              }}
            >
              <MetricSummary metric={card} />
              <Trend metric={card} />
            </button>
          ))}
        </div>
      </div>
      {selected && (
        <section
          className="board-insight-expanded"
          aria-label={selected.label + " history"}
          onKeyDown={(event) => {
            if (event.key === "Escape") close();
          }}
        >
          <Tool icon="close" label="Close insight" autoFocus onClick={close} />
          <MetricSummary metric={selected} expanded />
          <Trend key={selected.id + period} metric={selected} expanded />
        </section>
      )}
    </section>
  );
}
