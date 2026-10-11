/**
 * Which saved login URLs may be filled into which browser origins.
 *
 * The rule is deliberately strict: same host (ignoring a leading `www.`),
 * same port, and https unless the saved URL itself says http. A saved URL
 * without a scheme means https, except for loopback and `.localhost`/`.test`
 * development hosts, which may also use http. Subdomains do not match; save
 * the exact sign-in host in the password manager instead, or turn on
 * `allowSubdomains`, which lets a saved host also fill hosts below it. That
 * never applies to a public suffix such as `github.io` or `co.uk`, which
 * belongs to many unrelated owners.
 */

import { getDomain } from "tldts";

const DEVELOPMENT_HOST = /^(localhost|127(?:\.\d{1,3}){3}|\[::1\])$|\.(localhost|test)$/i;

/**
 * Whether other hosts may sit below this saved host: it is a registrable
 * domain or a name under one. A public suffix, an IP address and a dotless
 * name like `localhost` have no such domain. Private suffixes (`github.io`,
 * `vercel.app`) count as public, since their subdomains belong to other people.
 */
const hasTrustedSubdomains = (host: string) =>
  getDomain(host, { allowPrivateDomains: true }) !== null;

const stripWww = (host: string) => host.replace(/^www\./i, "");

const parseUrl = (value: string): URL | null => {
  try {
    return new URL(value);
  } catch {
    return null;
  }
};

interface SavedTarget {
  readonly host: string;
  readonly port: string;
  readonly schemes: ReadonlySet<string>;
}

const defaultPort = (scheme: string) => (scheme === "http:" ? "80" : "443");

/** Parses one saved login URL into the hosts and schemes it may fill. */
export function parseSavedUrl(saved: string): SavedTarget | null {
  const trimmed = saved.trim();
  if (trimmed.length === 0) return null;
  const explicit = /^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed);
  const url = parseUrl(explicit ? trimmed : `https://${trimmed}`);
  if (!url || (url.protocol !== "https:" && url.protocol !== "http:") || !url.hostname) {
    return null;
  }
  const host = stripWww(url.hostname.toLowerCase());
  const schemes = new Set([url.protocol]);
  if (!explicit && DEVELOPMENT_HOST.test(url.hostname)) schemes.add("http:");
  return { host, port: url.port, schemes };
}

/**
 * The tab's origin when one of the saved URLs matches it, otherwise null.
 * The returned origin is what the desktop re-checks right before filling.
 */
export function matchingOrigin(
  savedUrls: ReadonlyArray<string>,
  tabUrl: string,
  options: { readonly allowSubdomains?: boolean } = {},
): string | null {
  const tab = parseUrl(tabUrl);
  if (!tab || (tab.protocol !== "https:" && tab.protocol !== "http:")) return null;
  const tabHost = stripWww(tab.hostname.toLowerCase());
  const tabPort = tab.port || defaultPort(tab.protocol);
  for (const saved of savedUrls) {
    const target = parseSavedUrl(saved);
    if (!target || !target.schemes.has(tab.protocol)) continue;
    const sameHost =
      target.host === tabHost ||
      (options.allowSubdomains === true &&
        tabHost.endsWith(`.${target.host}`) &&
        hasTrustedSubdomains(target.host));
    if (!sameHost) continue;
    // An unstated saved port means the scheme default for the tab's scheme.
    if ((target.port || defaultPort(tab.protocol)) !== tabPort) continue;
    return tab.origin;
  }
  return null;
}

/** The host an agent asked for: a bare host or the host of a full URL. */
export function requestedHost(domain: string): string | null {
  return parseSavedUrl(domain)?.host ?? null;
}

/**
 * Whether a saved item belongs to the requested host. Looser than
 * `matchingOrigin` so a request for `github.com` also lists an item saved
 * for `https://github.com/login`; filling still requires an exact origin.
 */
export function savedUrlsMatchHost(savedUrls: ReadonlyArray<string>, host: string): boolean {
  return savedUrls.some((saved) => parseSavedUrl(saved)?.host === host);
}
