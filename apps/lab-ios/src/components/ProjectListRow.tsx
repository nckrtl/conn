import type { ReactNode } from "react";
import { ProjectFavicon } from "./ProjectFavicon";
import { StatusDot, type DotState } from "./StatusDot";

export function ProjectListRow(props: {
  project: string;
  light: boolean;
  status: DotState;
  statusLabel?: string;
  title: string;
  titleTrailing?: ReactNode;
  onOpen: () => void;
  children: ReactNode;
}) {
  return (
    <button className="m-row" onClick={props.onOpen}>
      <span className="m-row-head">
        <ProjectFavicon project={props.project} light={props.light}>
          <StatusDot
            state={props.status}
            ring="var(--color-screen)"
            {...(props.statusLabel && { label: props.statusLabel })}
          />
        </ProjectFavicon>
        <span
          className="m-row-title"
          // oxlint-disable-next-line t3code/no-native-title-tooltip -- lab hover reveals the full clamped title
          title={props.title}
        >
          {props.title}
        </span>
        {props.titleTrailing}
      </span>
      <span className="m-row-meta">{props.children}</span>
    </button>
  );
}
