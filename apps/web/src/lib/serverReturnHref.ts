/**
 * The sign-in return link a server gets. The T3 server accepts only upstream's desktop schemes
 * (`t3code://`, `t3code-dev://`), so a renamed app sends the upstream form of its own address and
 * still handles links in that scheme.
 */
export function serverReturnHref(href: string): string {
  let url: URL;
  try {
    url = new URL(href);
  } catch {
    return href;
  }
  if (url.protocol === "http:" || url.protocol === "https:" || url.host !== "app") return href;
  const scheme = url.protocol.slice(0, -1);
  if (scheme === "t3code" || scheme === "t3code-dev") return href;
  const upstream = scheme.endsWith("-dev") ? "t3code-dev" : "t3code";
  return `${upstream}://app${url.pathname}${url.search}${url.hash}`;
}
