#!/usr/bin/env node
/**
 * Builds Conn's iOS custom symbols: one `.symbolset` per entry in
 * apps/mobile/modules/conn-symbols/symbols.json, drawn from the Phosphor icon it
 * names. The conn-symbols module ships them and returns them in place of the SF
 * Symbol of the same name (see ConnSymbols.swift).
 *
 * The Phosphor paths come from @phosphor-icons/react, a dependency of apps/web.
 * Run this after changing symbols.json and commit the output:
 *
 *   node scripts/build-conn-symbols.ts
 */
import * as NodeFS from "node:fs";
import * as NodeModule from "node:module";
import * as NodePath from "node:path";

const repoRoot = NodePath.resolve(import.meta.dirname, "..");
const moduleDir = NodePath.join(repoRoot, "apps/mobile/modules/conn-symbols");
const catalog = NodePath.join(moduleDir, "ios/ConnSymbols.xcassets");

type Weight = "fill" | "bold" | "regular";
type Entry = string | { icon: string; weight?: Weight; mirrored?: boolean };

const webRequire = NodeModule.createRequire(NodePath.join(repoRoot, "apps/web/package.json"));
const React = webRequire("react") as typeof import("react");
const { renderToStaticMarkup } = webRequire(
  "react-dom/server",
) as typeof import("react-dom/server");
const phosphorEntry = webRequire
  .resolve("@phosphor-icons/react")
  .replace("index.cjs.js", "index.es.js");
const Phosphor = (await import(phosphorEntry)) as Record<string, unknown>;

// SF Symbols template geometry (points at a 100pt font, template v2 "M" row).
const BASELINE_M = 1126;
const CAPLINE_M = 1055.54;
// Phosphor's 256-unit box maps to 90 units: its 224-unit drawing then reads about
// the size of an SF Symbol, centred on the middle of the cap height.
const BOX = 90;
const SCALE = BOX / 256;
const TOP = -(BASELINE_M - CAPLINE_M) / 2 - BOX / 2;
const LEFT = 1500;

/** Scales a path from the 256 box to the glyph box, optionally mirrored. */
function transformPath(d: string, mirrored: boolean): string {
  const tokens = d.match(/[a-zA-Z]|-?(?:\d+\.?\d*|\.\d+)(?:e-?\d+)?/g) ?? [];
  const out: string[] = [];
  const fmt = (n: number) => String(Math.round(n * 1000) / 1000);
  const ax = (x: number) => (mirrored ? BOX - x * SCALE : x * SCALE);
  const ay = (y: number) => TOP + y * SCALE;
  const rx = (dx: number) => (mirrored ? -dx : dx) * SCALE;
  const ry = (dy: number) => dy * SCALE;
  let command = "";
  let i = 0;
  const next = () => Number(tokens[i++]);
  while (i < tokens.length) {
    if (/[a-zA-Z]/.test(tokens[i]!)) {
      command = tokens[i++]!;
      out.push(command);
      if (command === "Z" || command === "z") continue;
    }
    const relative = command === command.toLowerCase();
    const x = relative ? rx : ax;
    const y = relative ? ry : ay;
    switch (command.toUpperCase()) {
      case "M":
      case "L":
      case "T":
        out.push(fmt(x(next())), fmt(y(next())));
        break;
      case "H":
        out.push(fmt(x(next())));
        break;
      case "V":
        out.push(fmt(y(next())));
        break;
      case "C":
        for (let k = 0; k < 3; k++) out.push(fmt(x(next())), fmt(y(next())));
        break;
      case "S":
      case "Q":
        for (let k = 0; k < 2; k++) out.push(fmt(x(next())), fmt(y(next())));
        break;
      case "A": {
        const radiusX = next() * SCALE;
        const radiusY = next() * SCALE;
        const rotation = next();
        const largeArc = next();
        const sweep = next();
        out.push(
          fmt(radiusX),
          fmt(radiusY),
          fmt(mirrored ? -rotation : rotation),
          String(largeArc),
          String(mirrored ? 1 - sweep : sweep),
          fmt(x(next())),
          fmt(y(next())),
        );
        break;
      }
      default:
        throw new Error(`Unsupported path command ${command}`);
    }
  }
  return out.join(" ");
}

function symbolSvg(paths: readonly string[]): string {
  const guide = 'style="fill:none;stroke:#27AAE1;opacity:1;stroke-width:0.5;"';
  const margin = (id: string, x: number) =>
    `<line id="${id}" ${guide} x1="${x}" x2="${x}" y1="${BASELINE_M - 100}" y2="${BASELINE_M + 20}"/>`;
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE svg PUBLIC "-//W3C//DTD SVG 1.1//EN" "http://www.w3.org/Graphics/SVG/1.1/DTD/svg11.dtd">
<svg version="1.1" xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" width="3300" height="2200">
 <g id="Notes">
  <text id="template-version" x="3036" y="1933">Template v.2.0</text>
 </g>
 <g id="Guides">
  <line id="Baseline-S" ${guide} x1="263" x2="3036" y1="696" y2="696"/>
  <line id="Capline-S" ${guide} x1="263" x2="3036" y1="625.541" y2="625.541"/>
  <line id="Baseline-M" ${guide} x1="263" x2="3036" y1="${BASELINE_M}" y2="${BASELINE_M}"/>
  <line id="Capline-M" ${guide} x1="263" x2="3036" y1="${CAPLINE_M}" y2="${CAPLINE_M}"/>
  <line id="Baseline-L" ${guide} x1="263" x2="3036" y1="1556" y2="1556"/>
  <line id="Capline-L" ${guide} x1="263" x2="3036" y1="1485.54" y2="1485.54"/>
  ${margin("left-margin-Regular-M", LEFT)}
  ${margin("right-margin-Regular-M", LEFT + BOX)}
 </g>
 <g id="Symbols">
  <g id="Regular-M" transform="matrix(1 0 0 1 ${LEFT} ${BASELINE_M})">
${paths.map((d) => `   <path d="${d}"/>`).join("\n")}
  </g>
 </g>
</svg>
`;
}

const symbols = JSON.parse(
  NodeFS.readFileSync(NodePath.join(moduleDir, "symbols.json"), "utf8"),
) as Record<string, Entry>;

NodeFS.rmSync(catalog, { recursive: true, force: true });
NodeFS.mkdirSync(catalog, { recursive: true });
NodeFS.writeFileSync(
  NodePath.join(catalog, "Contents.json"),
  `${JSON.stringify({ info: { author: "xcode", version: 1 } }, null, 2)}\n`,
);

for (const [name, entry] of Object.entries(symbols)) {
  const {
    icon,
    weight = "fill",
    mirrored = false,
  } = typeof entry === "string" ? { icon: entry } : entry;
  const component = Phosphor[`${icon}Icon`];
  if (!component) throw new Error(`${name}: Phosphor has no ${icon}`);
  const markup = renderToStaticMarkup(React.createElement(component as never, { weight }));
  const paths = [...markup.matchAll(/<path d="([^"]+)"/g)].map((match) =>
    transformPath(match[1]!, mirrored),
  );
  if (paths.length === 0) throw new Error(`${name}: ${icon} rendered no paths`);
  const dir = NodePath.join(catalog, `${name}.symbolset`);
  NodeFS.mkdirSync(dir);
  NodeFS.writeFileSync(NodePath.join(dir, `${name}.svg`), symbolSvg(paths));
  NodeFS.writeFileSync(
    NodePath.join(dir, "Contents.json"),
    `${JSON.stringify(
      {
        info: { author: "xcode", version: 1 },
        symbols: [{ filename: `${name}.svg`, idiom: "universal" }],
      },
      null,
      2,
    )}\n`,
  );
}

const names = Object.keys(symbols).sort();
NodeFS.writeFileSync(
  NodePath.join(moduleDir, "ios/ConnSymbolNames.swift"),
  `// Generated by scripts/build-conn-symbols.ts from symbols.json. Do not edit.
let connSymbolNames: Set<String> = [
${names.map((name) => `  "${name}",`).join("\n")}
]
`,
);

console.log(`Wrote ${names.length} symbols to ${NodePath.relative(repoRoot, catalog)}.`);
