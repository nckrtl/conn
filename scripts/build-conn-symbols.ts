#!/usr/bin/env node
// @effect-diagnostics nodeBuiltinImport:off globalConsole:off - a one-off asset generator run by hand.
/**
 * Builds Conn's iOS custom symbols, one `.symbolset` per SF name in the icon set's manifest
 * (`sf` in assets/conn/superheroicons/manifest.json), from its 16px solid glyphs (see
 * ConnSymbols.swift). Run it after changing the set and commit the output:
 * `node scripts/build-conn-symbols.ts`.
 */
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

const repoRoot = NodePath.resolve(import.meta.dirname, "..");
const moduleDir = NodePath.join(repoRoot, "apps/mobile/modules/conn-symbols");
const catalog = NodePath.join(moduleDir, "ios/ConnSymbols.xcassets");
const setDir = NodePath.join(repoRoot, "assets/conn/superheroicons");

// SF Symbols template geometry (points at a 100pt font, template v2 "M" row).
const BASELINE_M = 1126;
const CAPLINE_M = 1055.54;
// The glyphs' 16-unit box maps to 90 units: their ~14-unit drawing then reads about the size
// of an SF Symbol, centred on the middle of the cap height.
const BOX = 90;
const SCALE = BOX / 16;
const TOP = -(BASELINE_M - CAPLINE_M) / 2 - BOX / 2;
const LEFT = 1500;

/** Scales a path from the 16 box to the symbol box. */
function transformPath(d: string): string {
  const mirrored = false;
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
  // A path's leading `m` moves to an absolute point; its implicit pairs after that stay relative.
  if (tokens[0] === "m") {
    i = 1;
    out.push("M", fmt(ax(next())), fmt(ay(next())));
    command = "l";
    if (i < tokens.length && !/[a-zA-Z]/.test(tokens[i]!)) out.push("l");
  }
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

interface SymbolPath {
  readonly d: string;
  readonly evenOdd: boolean;
}

function symbolSvg(paths: readonly SymbolPath[]): string {
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
${paths.map((p) => `   <path${p.evenOdd ? ' style="fill-rule:evenodd;"' : ""} d="${p.d}"/>`).join("\n")}
  </g>
 </g>
</svg>
`;
}

const manifest = JSON.parse(
  NodeFS.readFileSync(NodePath.join(setDir, "manifest.json"), "utf8"),
) as { readonly sf: Readonly<Record<string, string>> };

/** Reads a glyph's paths in its 16-unit box; a rect becomes a rounded-rect path. */
function readGlyph(concept: string): SymbolPath[] {
  const file = NodePath.join(setDir, "16/solid", `${concept}.svg`);
  if (!NodeFS.existsSync(file)) throw new Error(`no glyph for concept "${concept}" (${file})`);
  const svg = NodeFS.readFileSync(file, "utf8");
  const paths: SymbolPath[] = [];
  for (const [, tag, raw] of svg.matchAll(/<(path|rect)\b([^>]*?)\/>/g)) {
    const attrs = Object.fromEntries(
      [...raw!.matchAll(/([a-z-]+)="([^"]*)"/g)].map((m) => [m[1]!, m[2]!]),
    );
    const evenOdd = attrs["fill-rule"] === "evenodd";
    if (tag === "path") {
      paths.push({ d: attrs.d!, evenOdd });
    } else {
      const [x, y, w, h] = ["x", "y", "width", "height"].map((key) => Number(attrs[key] ?? 0)) as [
        number,
        number,
        number,
        number,
      ];
      const r = Math.min(Number(attrs.rx ?? 0), w / 2, h / 2);
      const d = `M${x + r} ${y}H${x + w - r}A${r} ${r} 0 0 1 ${x + w} ${y + r}V${y + h - r}A${r} ${r} 0 0 1 ${x + w - r} ${y + h}H${x + r}A${r} ${r} 0 0 1 ${x} ${y + h - r}V${y + r}A${r} ${r} 0 0 1 ${x + r} ${y}Z`;
      paths.push({ d, evenOdd });
    }
  }
  if (paths.length === 0) throw new Error(`${file}: no paths`);
  return paths;
}

NodeFS.rmSync(catalog, { recursive: true, force: true });
NodeFS.mkdirSync(catalog, { recursive: true });
NodeFS.writeFileSync(
  NodePath.join(catalog, "Contents.json"),
  `${JSON.stringify({ info: { author: "xcode", version: 1 } }, null, 2)}\n`,
);

for (const [name, concept] of Object.entries(manifest.sf)) {
  const paths = readGlyph(concept).map((p) => ({ ...p, d: transformPath(p.d) }));
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

const names = Object.keys(manifest.sf).sort();
NodeFS.writeFileSync(
  NodePath.join(moduleDir, "ios/ConnSymbolNames.swift"),
  `// Generated by scripts/build-conn-symbols.ts from assets/conn/superheroicons. Do not edit.
let connSymbolNames: Set<String> = [
${names.map((name) => `  "${name}",`).join("\n")}
]
`,
);

// Android draws the same glyphs with react-native-svg (AppSymbol.android.tsx).
const camel = (concept: string) =>
  concept.replace(/-([a-z0-9])/g, (_m, c: string) => c.toUpperCase());
const concepts = [...new Set(Object.values(manifest.sf))].sort();
const androidOut = NodePath.join(repoRoot, "apps/mobile/src/components/ui/connGlyphs.generated.ts");
NodeFS.writeFileSync(
  androidOut,
  `// Generated by scripts/build-conn-symbols.ts from assets/conn/superheroicons. Do not edit.
import type { ConnGlyphData } from "./ConnGlyph";

${concepts.map((concept) => `const ${camel(concept)}Glyph = ${JSON.stringify(readGlyph(concept))} satisfies ConnGlyphData;`).join("\n")}

/** Glyph per SF Symbol name in the icon set's manifest. */
export const CONN_GLYPH_BY_SF_NAME = {
${names.map((name) => `  ${JSON.stringify(name)}: ${camel(manifest.sf[name]!)}Glyph,`).join("\n")}
} as const;
`,
);
NodeChildProcess.execFileSync("vp", ["fmt", androidOut], { cwd: repoRoot, stdio: "inherit" });

console.log(`Wrote ${names.length} symbols to ${NodePath.relative(repoRoot, catalog)}.`);
