import type { ReactNode } from "react";
import "./StatusDot.css";

export type DotState = "working" | "waiting" | "done" | "failed" | "limited" | "merged";

/** A 6pt dot with a 2pt ring in the surface colour behind it (apps/mobile StatusBadgeDot). */
export function StatusDot(props: {
  readonly state: DotState;
  readonly ring: string;
  readonly label?: string | undefined;
}) {
  return (
    <span
      className="m-dot"
      style={{ background: props.ring }}
      role={props.label ? "img" : undefined}
      aria-label={props.label}
      // oxlint-disable-next-line t3code/no-native-title-tooltip -- lab hover exposes the color-only status
      title={props.label}
    >
      <span className="m-dot-core" data-state={props.state} />
    </span>
  );
}

/** An icon with the status dot on its top-right corner; the ring takes the surface colour. */
export function WithStatusDot(props: {
  readonly state: DotState;
  readonly ring: string;
  readonly children: ReactNode;
  readonly label?: string | undefined;
}) {
  return (
    <span
      className="m-dot-host"
      // oxlint-disable-next-line t3code/no-native-title-tooltip -- lab hover exposes the status across the icon
      title={props.label}
    >
      {props.children}
      <span className="m-dot-corner">
        <StatusDot state={props.state} ring={props.ring} label={props.label} />
      </span>
    </span>
  );
}
