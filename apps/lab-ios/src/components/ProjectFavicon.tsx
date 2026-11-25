import type { ReactNode } from "react";
import "./ProjectFavicon.css";

const colors = [
  "#9ca3af",
  "#f87171",
  "#fb923c",
  "#fbbf24",
  "#facc15",
  "#a3e635",
  "#4ade80",
  "#34d399",
  "#2dd4bf",
  "#22d3ee",
  "#38bdf8",
  "#60a5fa",
  "#818cf8",
  "#a78bfa",
  "#c084fc",
  "#e879f9",
  "#f472b6",
  "#fb7185",
];
const lightColors = [
  "#4b5563",
  "#dc2626",
  "#ea580c",
  "#d97706",
  "#ca8a04",
  "#65a30d",
  "#16a34a",
  "#059669",
  "#0d9488",
  "#0891b2",
  "#0284c7",
  "#2563eb",
  "#4f46e5",
  "#7c3aed",
  "#9333ea",
  "#c026d3",
  "#db2777",
  "#e11d48",
];
export function ProjectFavicon({
  project,
  light,
  children,
}: {
  project: string;
  light: boolean;
  children: ReactNode;
}) {
  const words = project.normalize("NFKC").match(/[\p{L}\p{N}]+/gu) ?? ["PR"];
  const first = words[0]!,
    second =
      first.slice(1).match(/\d/)?.[0] ?? (words.length > 1 ? words.at(-1)![0] : first.at(-1));
  const hash = Array.from(project.trim().normalize("NFKC").toLowerCase()).reduce(
    (n, c) => (n * 31 + c.codePointAt(0)!) % colors.length,
    0,
  );
  return (
    <span className="m-favicon-host">
      <span
        className="m-favicon"
        aria-label={project}
        role="img"
        style={{
          color: (light ? lightColors : colors)[hash],
          background: "color-mix(in srgb,currentColor 16%,transparent)",
        }}
      >
        {(first[0]! + second).toUpperCase()}
      </span>
      <span className="m-favicon-dot">{children}</span>
    </span>
  );
}
