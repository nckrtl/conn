// Lets one extra origin (the tab's @nckrtl/annotator server) load scripts and connect, in
// a response's Content-Security-Policy. Nothing else in the policy changes. Directive syntax:
// https://www.w3.org/TR/CSP3/#parse-serialized-policy

const POLICY_HEADERS: ReadonlySet<string> = new Set([
  "content-security-policy",
  "content-security-policy-report-only",
]);

interface Directive {
  readonly name: string;
  readonly sources: ReadonlyArray<string>;
  /** The directive as the server wrote it; kept for directives this module leaves alone. */
  readonly raw: string;
}

function parsePolicy(policy: string): Directive[] {
  return policy
    .split(";")
    .map((raw) => raw.trim())
    .filter((raw) => raw !== "")
    .map((raw) => {
      const [name = "", ...sources] = raw.split(/[\t\n\f\r ]+/);
      return { name: name.toLowerCase(), sources, raw };
    });
}

const isNone = (sources: ReadonlyArray<string>) =>
  sources.length === 1 && sources[0]!.toLowerCase() === "'none'";

function withSources(
  sources: ReadonlyArray<string>,
  additions: ReadonlyArray<string>,
): ReadonlyArray<string> {
  // `'none'` must stand alone, so it gives way to the additions.
  const base = isNone(sources) ? [] : sources;
  const present = new Set(base.map((source) => source.toLowerCase()));
  return [...base, ...additions.filter((source) => !present.has(source.toLowerCase()))];
}

/** `http://host:port` → `ws://host:port`, `https:` → `wss:`; null for other schemes. */
function socketOrigin(origin: string): string | null {
  if (origin.startsWith("https://")) return `wss://${origin.slice("https://".length)}`;
  if (origin.startsWith("http://")) return `ws://${origin.slice("http://".length)}`;
  return null;
}

// Adds `origin` to script-src, script-src-elem (if present) and connect-src (plus ws/wss).
// A missing one is built from default-src, so nothing else widens; with no default-src it is
// unrestricted and stays absent. Limitation: under 'strict-dynamic' browsers ignore host
// sources, so such a policy still blocks the overlay.
export function allowOriginInPolicy(policy: string, origin: string): string {
  const directives = parsePolicy(policy);
  // Only the first directive of a name counts; browsers ignore later duplicates.
  const first = new Map<string, Directive>();
  for (const directive of directives) {
    if (!first.has(directive.name)) first.set(directive.name, directive);
  }
  const socket = socketOrigin(origin);
  const targets: ReadonlyArray<readonly [string, ReadonlyArray<string>]> = [
    ["script-src", [origin]],
    ["script-src-elem", [origin]],
    ["connect-src", socket ? [origin, socket] : [origin]],
  ];
  const fallback = first.get("default-src");
  const replaced = new Map<Directive, string>();
  const added: string[] = [];
  for (const [name, additions] of targets) {
    const directive = first.get(name);
    if (directive) {
      replaced.set(directive, [name, ...withSources(directive.sources, additions)].join(" "));
    } else if (name !== "script-src-elem" && fallback) {
      added.push([name, ...withSources(fallback.sources, additions)].join(" "));
    }
  }
  return [
    ...directives.map((directive) => replaced.get(directive) ?? directive.raw),
    ...added,
  ].join("; ");
}

/** A header value may hold several comma-separated policies; each one is amended. */
function allowOriginInHeaderValue(value: string, origin: string): string {
  return value
    .split(",")
    .filter((policy) => policy.trim() !== "")
    .map((policy) => allowOriginInPolicy(policy, origin))
    .join(", ");
}

/** The response sets an enforced (not report-only) policy in a header. */
export function hasEnforcedPolicy(headers: Record<string, ReadonlyArray<string>>): boolean {
  return Object.entries(headers).some(
    ([name, values]) =>
      name.toLowerCase() === "content-security-policy" &&
      values.some((value) => value.trim() !== ""),
  );
}

export interface AmendedPolicyHeaders {
  readonly headers: Record<string, string[]>;
  /** The response sets an enforced policy, so the origin needed the amendment to load. */
  readonly enforced: boolean;
  readonly changed: boolean;
}

/**
 * Response headers (as Electron's `onHeadersReceived` gives them) with `origin` allowed by
 * every CSP and CSP-Report-Only header. Policies in `<meta>` tags cannot be changed here.
 */
export function allowOriginInPolicyHeaders(
  headers: Record<string, string[]>,
  origin: string,
): AmendedPolicyHeaders {
  let changed = false;
  const next: Record<string, string[]> = {};
  for (const [name, values] of Object.entries(headers)) {
    const lower = name.toLowerCase();
    if (!POLICY_HEADERS.has(lower)) {
      next[name] = values;
      continue;
    }
    next[name] = values.map((value) => {
      const amended = allowOriginInHeaderValue(value, origin);
      if (amended !== value) changed = true;
      return amended;
    });
  }
  return { headers: changed ? next : headers, enforced: hasEnforcedPolicy(headers), changed };
}
