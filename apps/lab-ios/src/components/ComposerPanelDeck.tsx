import type { ReactNode } from "react";
import "./ComposerPanel.css";

export function ComposerPanelDeck({
  remaining,
  kind,
  children,
}: {
  remaining: number;
  kind: "approval" | "question" | "secret";
  children: ReactNode;
}) {
  return (
    <div className="m-composer-deck" data-kind={kind} data-layers={Math.min(remaining - 1, 2)}>
      {children}
    </div>
  );
}
