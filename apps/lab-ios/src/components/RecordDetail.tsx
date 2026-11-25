import type { ReactNode } from "react";
import { GlassButton, GlassHeader } from "./GlassHeader";
import { Icon } from "./Icon";
import type { IconName } from "../icons.generated";
import { OfflinePill } from "./OfflinePill";
import "./RecordDetail.css";

export function DetailField({
  icon,
  label,
  children,
}: {
  icon: IconName;
  label: string;
  children: ReactNode;
}) {
  return (
    <div className="ios-detail-field">
      <dt
        // oxlint-disable-next-line t3code/no-native-title-tooltip -- lab hover labels the field icon when the text is hidden
        title={label}
      >
        <span className="ios-field-label">{label}</span>
        <Icon name={icon} size={15} />
      </dt>
      <dd>{children}</dd>
    </div>
  );
}

interface RecordHeadingProps {
  title: string;
  fields: ReactNode;
}

function RecordHeading(props: RecordHeadingProps) {
  return (
    <header className="ios-record-heading">
      <dl>{props.fields}</dl>
      <h1>{props.title}</h1>
    </header>
  );
}

const sections = {
  overview: { label: "Overview", icon: "file-text" },
  subtasks: { label: "Subtasks", icon: "checklist" },
  agents: { label: "Agents", icon: "users" },
  checks: { label: "Checks", icon: "check-circle" },
  timeline: { label: "Timeline", icon: "clock" },
  code: { label: "Code", icon: "code" },
} as const satisfies Record<string, { label: string; icon: IconName }>;

export function RecordDetail<Tab extends keyof typeof sections>(
  props: RecordHeadingProps & {
    identity: string;
    navLabel: string;
    tabs: readonly Tab[];
    tab: Tab;
    subtitle?: string | undefined;
    headerAction?: ReactNode;
    onTab: (tab: Tab) => void;
    onBack: () => void;
    offline: boolean;
    children: ReactNode;
  },
) {
  const active = sections[props.tab];
  return (
    <section className="ios-record" aria-label={props.identity}>
      <GlassHeader
        title={props.tab === "overview" ? props.identity : active.label}
        subtitle={props.subtitle}
        trailing={props.headerAction}
        leading={<GlassButton label="Back" icon="chevron-left" onClick={props.onBack} />}
      />
      <div className="ios-record-scroll m-scroll" key={props.tab}>
        {props.tab === "overview" && <RecordHeading {...props} />}
        <section className="ios-detail-body" aria-label={active.label}>
          {props.children}
        </section>
      </div>
      <nav className="m-wsbar ios-record-nav" aria-label={props.navLabel}>
        {props.offline && <OfflinePill />}
        <div className="m-wsbar-tabs">
          {props.tabs.map((id) => (
            <button
              key={id}
              type="button"
              className="m-wsbar-tab"
              // oxlint-disable-next-line t3code/no-native-title-tooltip -- lab hover labels the icon-only tab
              title={sections[id].label}
              aria-label={sections[id].label}
              data-active={props.tab === id}
              aria-current={props.tab === id ? "page" : undefined}
              onClick={() => props.onTab(id)}
            >
              <Icon name={sections[id].icon} size={22} />
            </button>
          ))}
        </div>
      </nav>
    </section>
  );
}
