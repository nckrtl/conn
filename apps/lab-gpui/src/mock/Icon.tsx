import type { ButtonHTMLAttributes } from "react";
import orbit from "../../../conn-gpui/crates/conn-app/assets/icons/brand/orbit.svg?raw";
import mcp from "../../../conn-gpui/crates/conn-app/assets/icons/brand/mcp.svg?raw";
import conn from "../../../conn-gpui/crates/conn-app/assets/icons/brand/conn-mark.svg?raw";
import openai from "../../../conn-gpui/crates/conn-app/assets/icons/brand/openai.svg?raw";
import antigravity from "../../../conn-gpui/crates/conn-app/assets/icons/brand/antigravity.png";
import grok from "../../../conn-gpui/crates/conn-app/assets/icons/brand/grok.svg?raw";
import claude from "../../../conn-gpui/crates/conn-app/assets/icons/brand/claude.svg?raw";

// Include only the native 16px glyphs drawn by the mock.
const icons = import.meta.glob<string>(
  "../../../conn-gpui/crates/conn-app/assets/icons/superhero/16/solid/{webhook,idea,clock,plug,keyboard,terminal-window,files,wrap-lines,copy,play,clean,forward,lock,edit,shield-off,chevron-up,maximize,minimize,desktop,panel-menu,chart,apps,briefcase,computer-mini,file-diff,file-code,refresh,chevrons-down-up,chevron-left,fast,list-add,reply,shield-check,device-rotate,external-link,table,folder-open,folder-git,layers,agent,arrow-up,add,branch,chevron-right,compose,folder-add,list,microphone,panel-bottom,pull-request,settings,usage,search,filter,sidebar-left,sidebar-right,terminal,star,checklist,folder,chevron-down,attach,send,ai,check,database,close,theme}.svg",
  { eager: true, import: "default", query: "?raw" },
);
const byName = Object.fromEntries(
  Object.entries({
    ...icons,
    "mcp.svg": mcp,
    "openai.svg": openai,
    "orbit.svg": orbit,
    "conn-mark.svg": conn,
    "claude.svg": claude,
    "grok.svg": grok,
  }).map(([path, svg]) => [path.split("/").pop()!.slice(0, -4), svg]),
);

export function Icon({ name }: { name: string }) {
  if (name === "antigravity")
    return <img aria-hidden="true" className="icon" alt="" src={antigravity} />;
  return (
    <span
      aria-hidden="true"
      className="icon"
      data-glyph={name}
      dangerouslySetInnerHTML={{ __html: byName[name] ?? "" }}
    />
  );
}
export function Tool({
  icon,
  label,
  showTooltip = true,
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & {
  icon: string;
  label: string;
  showTooltip?: boolean;
}) {
  return (
    <button
      type="button"
      className="tool"
      data-tip={showTooltip ? label : undefined}
      aria-label={label}
      {...props}
    >
      <Icon name={icon} />
    </button>
  );
}
