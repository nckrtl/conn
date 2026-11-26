import { EnvironmentId, ThreadId, type ScopedThreadRef } from "@t3tools/contracts";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import { DEFAULT_HOSTED_APP_URL } from "./connectAuth.ts";

export const THREAD_LINK_PROTOCOL = "t3-thread";
/**
 * The schemes of `conn://thread/<environmentId>/<threadId>`, which the Conn Server and the native
 * desktop write. `conn-dev` is the development build's scheme. A sanitizer allows these as schemes
 * only; `parseThreadLinkHref` decides which of their links are thread links.
 */
export const CONN_THREAD_LINK_PROTOCOLS = ["conn", "conn-dev"] as const;
const CONN_THREAD_PREFIXES = CONN_THREAD_LINK_PROTOCOLS.map((scheme) => `${scheme}://thread/`);
const V1_PREFIX = `${THREAD_LINK_PROTOCOL}://v1/`;
const V2_PREFIX = `${THREAD_LINK_PROTOCOL}://v2/`;
const HOSTED_PREFIX = `${DEFAULT_HOSTED_APP_URL}/threads/`;
const HOSTED_SEGMENT = "[A-Za-z0-9_%-]+";
const HOSTED_LINK = `${HOSTED_PREFIX.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&")}${HOSTED_SEGMENT}/${HOSTED_SEGMENT}`;
// The scheme is case-insensitive in a URL, and `parse_thread_link` in conn_desktop reads it so.
// Spelled out in classes, because Hermes lacks inline flag groups.
const THREAD_HREF = String.raw`(?:t3-thread:\/\/v[12]\/|[Cc][Oo][Nn][Nn](?:-[Dd][Ee][Vv])?:\/\/[Tt][Hh][Rr][Ee][Aa][Dd]\/)`;
const CONN_THREAD_TERMINATOR = /[\s<>)"']/u;
// A label stops at any bracket, so a run of unclosed brackets is scanned once, not once per bracket.
const LABEL = String.raw`[^[\]\n]*`;
// Earlier alternatives claim text so later ones cannot match inside it: an escaped character opens
// nothing, code is literal, and a link to anywhere else keeps a thread URL in its label or href.
const THREAD_LINK_OUTSIDE_CODE = new RegExp(
  [
    String.raw`\\[!-/:-@[-\`{-~]`,
    String.raw`(?<fence>(\`{3,}|~{3,})[\s\S]*?(?:\2|$))`,
    String.raw`(?<span>(\`+)[^\n]*?\4)`,
    // A labeled link's destination may be angle-bracketed, as CommonMark allows: [label](<href>).
    String.raw`\[(?<label>${LABEL})\]\((?:<(?<angleHref>${THREAD_HREF}[^\s<>]+|${HOSTED_LINK})>|(?<href>${THREAD_HREF}[^\s>)]+|${HOSTED_LINK}))\)`,
    String.raw`\[${LABEL}\]\((?:<[^<>\n]*>|[^\s()]*(?:\([^\s()]*\)[^\s()]*)*)(?:[ \t]+(?:"[^"\n]*"|'[^'\n]*'))?\)`,
    String.raw`<(?<autolink>${THREAD_HREF}[^\s<>]+|${HOSTED_LINK})>`,
    // After a URL character the hosted link is part of a longer URL, such as a redirect target.
    String.raw`(?<![A-Za-z0-9%/?#=&@+-])(?<bare>${HOSTED_LINK})(?![\w%/?#-])`,
  ].join("|"),
  "g",
);

const decodeThreadId = Schema.decodeUnknownOption(ThreadId);
const decodeEnvironmentId = Schema.decodeUnknownOption(EnvironmentId);

/** A v1 link names no environment; the message's own, or a unique match, stands in. */
export interface ThreadLink {
  readonly environmentId: EnvironmentId | null;
  readonly threadId: ThreadId;
}

// Escapes even URL-safe punctuation, so a sentence's closing period never reads as part of an id.
const hostedSegment = (id: string) =>
  encodeURIComponent(id).replace(
    /[.!~*'()]/g,
    (character) => `%${character.charCodeAt(0).toString(16).toUpperCase()}`,
  );

/** Opens the thread from anywhere: the hosted app offers the desktop app, the mobile app, or itself. */
export function hostedThreadLink(ref: ScopedThreadRef, origin = DEFAULT_HOSTED_APP_URL): string {
  const path = `/threads/${hostedSegment(ref.environmentId)}/${hostedSegment(ref.threadId)}`;
  return new URL(path, origin).toString();
}

const HOSTED_PATH = new RegExp(`^(${HOSTED_SEGMENT})/(${HOSTED_SEGMENT})$`);

function parseHostedThreadLink(href: string): ThreadLink | null {
  const match = HOSTED_PATH.exec(href.slice(HOSTED_PREFIX.length));
  if (!match) return null;
  try {
    const environmentId = Option.getOrNull(decodeEnvironmentId(decodeURIComponent(match[1]!)));
    const threadId = Option.getOrNull(decodeThreadId(decodeURIComponent(match[2]!)));
    return environmentId === null || threadId === null ? null : { environmentId, threadId };
  } catch {
    return null;
  }
}

/**
 * `conn://thread/<environmentId>/<threadId>`, read as `parse_thread_link` in conn_desktop reads it:
 * a case-insensitive scheme, surrounding whitespace ignored, a query or fragment ignored, a
 * trailing slash ignored, and no id with a slash in it. Both ids are required.
 */
function parseConnThreadLink(href: string): ThreadLink | null {
  const trimmed = href.trim();
  const lowered = trimmed.toLowerCase();
  const prefix = CONN_THREAD_PREFIXES.find((candidate) => lowered.startsWith(candidate));
  if (prefix === undefined) return null;
  const rest = trimmed.slice(prefix.length);
  if (CONN_THREAD_TERMINATOR.test(rest)) return null;
  const path = rest.split(/[?#]/u)[0] ?? "";
  const slash = path.indexOf("/");
  if (slash < 0) return null;
  const environmentSegment = path.slice(0, slash);
  const threadSegment = path.slice(slash + 1).replace(/\/+$/u, "");
  if (environmentSegment === "" || threadSegment === "" || threadSegment.includes("/")) return null;
  const environmentId = Option.getOrNull(decodeEnvironmentId(environmentSegment));
  const threadId = Option.getOrNull(decodeThreadId(threadSegment));
  return environmentId === null || threadId === null ? null : { environmentId, threadId };
}

/**
 * The ids as written. Thread ids can hold percent escapes of their own, so they are not decoded,
 * except in a hosted link, which escapes them itself. Reads `conn://thread/<env>/<thread>`,
 * `t3-thread://v2/<env>/<thread>` and `t3-thread://v1/<thread>`, and the hosted link.
 */
export function parseThreadLinkHref(href: string): ThreadLink | null {
  if (href.startsWith(HOSTED_PREFIX)) return parseHostedThreadLink(href);
  const connLink = parseConnThreadLink(href);
  if (connLink !== null) return connLink;
  if (href.startsWith(V1_PREFIX)) {
    const threadId = Option.getOrNull(decodeThreadId(href.slice(V1_PREFIX.length)));
    return threadId === null ? null : { environmentId: null, threadId };
  }
  if (!href.startsWith(V2_PREFIX)) return null;
  const path = href.slice(V2_PREFIX.length);
  const slash = path.indexOf("/");
  if (slash < 0) return null;
  const environmentId = Option.getOrNull(decodeEnvironmentId(path.slice(0, slash)));
  const threadId = Option.getOrNull(decodeThreadId(path.slice(slash + 1)));
  return environmentId === null || threadId === null ? null : { environmentId, threadId };
}

function percentDecodedThreadLinkId(threadId: ThreadId): ThreadId | null {
  try {
    const decoded = decodeURIComponent(threadId);
    return decoded === threadId ? null : Option.getOrNull(decodeThreadId(decoded));
  } catch {
    return null;
  }
}

/** The threads a link can name, in its own environment or else the message's: as written, then decoded. */
export function threadLinkCandidates(
  link: ThreadLink,
  messageEnvironmentId: EnvironmentId,
): ReadonlyArray<ScopedThreadRef> {
  const environmentId = link.environmentId ?? messageEnvironmentId;
  const decodedId = percentDecodedThreadLinkId(link.threadId);
  const written = { environmentId, threadId: link.threadId };
  return decodedId === null ? [written] : [written, { environmentId, threadId: decodedId }];
}

/** A v1 link its message's environment lacks opens a unique match elsewhere; a v2 link never does. */
export function guessThreadLinkRef(
  link: ThreadLink,
  refs: ReadonlyArray<ScopedThreadRef>,
): ScopedThreadRef | null {
  if (link.environmentId !== null) return null;
  const decodedId = percentDecodedThreadLinkId(link.threadId);
  for (const threadId of decodedId === null ? [link.threadId] : [link.threadId, decodedId]) {
    let match: ScopedThreadRef | null = null;
    for (const ref of refs) {
      if (ref.threadId !== threadId) continue;
      if (match !== null) return null;
      match = ref;
    }
    if (match !== null) return match;
  }
  return null;
}

function threadLinkHref(link: ThreadLink): string {
  return link.environmentId === null
    ? `${V1_PREFIX}${link.threadId}`
    : `${V2_PREFIX}${link.environmentId}/${link.threadId}`;
}

const linkLabel = (label: string | undefined) =>
  label
    ?.replace(/[[\]\\\r\n]/g, " ")
    .replace(/\s+/g, " ")
    .trim();

/** Without a label, an autolink: clients show the thread's current title. */
export function formatThreadLink(ref: ThreadLink, label?: string): string {
  const cleaned = linkLabel(label);
  const href = threadLinkHref(ref);
  const destination = /[()]/.test(href) ? `<${href}>` : href;
  return cleaned ? `[${cleaned}](${destination})` : `<${href}>`;
}

/** What a person copies out of T3 Code: a Markdown link that opens the thread anywhere. */
export function formatHostedThreadLink(
  ref: ScopedThreadRef,
  label: string,
  origin?: string,
): string {
  const href = hostedThreadLink(ref, origin);
  const cleaned = linkLabel(label);
  return cleaned ? `[${cleaned}](${href})` : href;
}

const CONN_THREAD_MENTION = /conn(?:-dev)?:\/\/thread\//iu;

export function hasThreadLinks(markdown: string): boolean {
  return (
    markdown.includes(`${THREAD_LINK_PROTOCOL}://v`) ||
    markdown.includes(HOSTED_PREFIX) ||
    CONN_THREAD_MENTION.test(markdown)
  );
}

/** Every thread the markdown's links can name, so their titles are keyed reads. */
export function threadLinkRefs(
  markdown: string,
  messageEnvironmentId: EnvironmentId,
): ReadonlyArray<ScopedThreadRef> {
  const refs = new Map<string, ScopedThreadRef>();
  // Hermes' matchAll yields matches without `groups`; exec keeps them.
  const pattern = new RegExp(THREAD_LINK_OUTSIDE_CODE);
  for (let match = pattern.exec(markdown); match !== null; match = pattern.exec(markdown)) {
    const href =
      match.groups?.angleHref ?? match.groups?.href ?? match.groups?.autolink ?? match.groups?.bare;
    const link = href === undefined ? null : parseThreadLinkHref(href);
    if (link === null) continue;
    for (const ref of threadLinkCandidates(link, messageEnvironmentId)) {
      refs.set(`${ref.environmentId}/${ref.threadId}`, ref);
    }
  }
  return [...refs.values()];
}

/** Rewrites each link outside code `replace` answers for. `label` is a Markdown link's own text. */
export function replaceThreadLinks(
  markdown: string,
  replace: (link: ThreadLink, label: string | undefined) => string | undefined,
): string {
  if (!hasThreadLinks(markdown)) return markdown;
  return markdown.replace(THREAD_LINK_OUTSIDE_CODE, (source, ...args) => {
    const groups = args.at(-1) as Partial<
      Record<"angleHref" | "href" | "autolink" | "bare" | "label", string>
    >;
    const href = groups.angleHref ?? groups.href ?? groups.autolink ?? groups.bare;
    const link = href === undefined ? null : parseThreadLinkHref(href);
    return (link && replace(link, groups.label)) ?? source;
  });
}
