import "./StatusRing.css";
import type { CSSProperties } from "react";
import { BRANDS, ICONS, type IconName } from "../icons.generated";

/** A superheroicons 24px solid glyph (apps/mobile's icon set; add names in generate-icons.mts). */
export function Icon(props: {
  readonly name: IconName;
  readonly size?: number;
  readonly style?: CSSProperties;
}) {
  const size = props.size ?? 20;
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="currentColor"
      aria-hidden
      style={{ flex: "none", display: "block", ...props.style }}
      dangerouslySetInnerHTML={{ __html: ICONS[props.name] }}
    />
  );
}

export function StatusRing({ spinning = false }: { spinning?: boolean }) {
  return (
    <svg
      className={spinning ? "ios-status-spinner" : undefined}
      width="18"
      height="18"
      viewBox="0 0 24 24"
      aria-hidden="true"
    >
      <circle
        cx="12"
        cy="12"
        r="8.75"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeDasharray={spinning ? "39 16" : undefined}
      />
    </svg>
  );
}

export type Provider = "claudeAgent" | "codex";

/** The provider mark: Claude's asterisk in its orange, Codex's knot in the text colour. */
export function ProviderIcon(props: {
  readonly provider: Provider;
  readonly size?: number;
  readonly muted?: boolean | undefined;
}) {
  const size = props.size ?? 16;
  const brand = BRANDS[props.provider];
  return (
    <svg
      width={size}
      height={size}
      viewBox={brand.viewBox}
      aria-hidden
      style={{
        flex: "none",
        display: "block",
        fill: props.provider === "claudeAgent" ? "#d97757" : "var(--color-foreground-muted)",
        opacity: props.muted ? 0.6 : 1,
      }}
    >
      {brand.paths.map((d) => (
        <path key={d.slice(0, 24)} d={d} fillRule="evenodd" />
      ))}
    </svg>
  );
}
