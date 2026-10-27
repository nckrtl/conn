import { describe, expect, it } from "vite-plus/test";

import { allowOriginInPolicy, allowOriginInPolicyHeaders } from "./ContentSecurityPolicy.ts";

const ORIGIN = "http://10.44.0.7:40953";

describe("allowOriginInPolicy", () => {
  it("adds the origin to script-src and connect-src only", () => {
    expect(
      allowOriginInPolicy(
        "script-src 'self' https://platform.twitter.com https://nckrtl.test:* 'unsafe-inline'; connect-src 'self' wss://nckrtl.test:* https://nckrtl.test:*; default-src 'self'",
        ORIGIN,
      ),
    ).toBe(
      "script-src 'self' https://platform.twitter.com https://nckrtl.test:* 'unsafe-inline' http://10.44.0.7:40953; " +
        "connect-src 'self' wss://nckrtl.test:* https://nckrtl.test:* http://10.44.0.7:40953 ws://10.44.0.7:40953; " +
        "default-src 'self'",
    );
  });

  it("uses wss for an https origin", () => {
    expect(allowOriginInPolicy("connect-src 'self'", "https://annotator.test")).toBe(
      "connect-src 'self' https://annotator.test wss://annotator.test",
    );
  });

  it("builds missing directives from default-src, so nothing else widens", () => {
    expect(allowOriginInPolicy("default-src 'self' https://cdn.test; img-src *", ORIGIN)).toBe(
      "default-src 'self' https://cdn.test; img-src *; " +
        "script-src 'self' https://cdn.test http://10.44.0.7:40953; " +
        "connect-src 'self' https://cdn.test http://10.44.0.7:40953 ws://10.44.0.7:40953",
    );
  });

  it("leaves a policy without script, connect or default directives alone", () => {
    expect(allowOriginInPolicy("frame-ancestors 'none'; img-src 'self'", ORIGIN)).toBe(
      "frame-ancestors 'none'; img-src 'self'",
    );
  });

  it("replaces 'none' with the origin alone", () => {
    expect(allowOriginInPolicy("script-src 'NONE'; default-src 'none'", ORIGIN)).toBe(
      "script-src http://10.44.0.7:40953; default-src 'none'; " +
        "connect-src http://10.44.0.7:40953 ws://10.44.0.7:40953",
    );
  });

  it("amends script-src-elem when present and does not add it otherwise", () => {
    expect(allowOriginInPolicy("script-src-elem 'self'; script-src 'self'", ORIGIN)).toBe(
      "script-src-elem 'self' http://10.44.0.7:40953; script-src 'self' http://10.44.0.7:40953",
    );
  });

  it("keeps nonces, hashes and 'strict-dynamic', and adds the host next to them", () => {
    expect(allowOriginInPolicy("script-src 'nonce-abc' 'strict-dynamic' 'sha256-x='", ORIGIN)).toBe(
      "script-src 'nonce-abc' 'strict-dynamic' 'sha256-x=' http://10.44.0.7:40953",
    );
  });

  it("does not add the origin twice, and treats directive names case-insensitively", () => {
    expect(allowOriginInPolicy(`Script-Src 'self' ${ORIGIN}`, ORIGIN)).toBe(
      `script-src 'self' ${ORIGIN}`,
    );
  });

  it("amends only the first of duplicate directives, as browsers read only that one", () => {
    expect(allowOriginInPolicy("script-src 'self'; script-src 'none'", ORIGIN)).toBe(
      "script-src 'self' http://10.44.0.7:40953; script-src 'none'",
    );
  });

  it("ignores empty directives and odd whitespace", () => {
    expect(allowOriginInPolicy(" ;script-src\t'self'  ;; ", ORIGIN)).toBe(
      "script-src 'self' http://10.44.0.7:40953",
    );
  });
});

describe("allowOriginInPolicyHeaders", () => {
  it("amends every policy header, enforced and report-only, in any case", () => {
    const result = allowOriginInPolicyHeaders(
      {
        "Content-Security-Policy": ["script-src 'self'", "connect-src 'self'"],
        "content-security-policy-report-only": ["script-src 'none'"],
        "Content-Type": ["text/html"],
      },
      ORIGIN,
    );
    expect(result).toEqual({
      enforced: true,
      changed: true,
      headers: {
        "Content-Security-Policy": [
          `script-src 'self' ${ORIGIN}`,
          `connect-src 'self' ${ORIGIN} ws://10.44.0.7:40953`,
        ],
        "content-security-policy-report-only": [`script-src ${ORIGIN}`],
        "Content-Type": ["text/html"],
      },
    });
  });

  it("amends each policy of a comma-separated list", () => {
    const result = allowOriginInPolicyHeaders(
      { "content-security-policy": ["script-src 'self', default-src 'none'"] },
      ORIGIN,
    );
    expect(result.headers["content-security-policy"]).toEqual([
      `script-src 'self' ${ORIGIN}, default-src 'none'; script-src ${ORIGIN}; connect-src ${ORIGIN} ws://10.44.0.7:40953`,
    ]);
  });

  it("returns the same headers when there is no policy", () => {
    const headers = { "content-type": ["text/html"] };
    expect(allowOriginInPolicyHeaders(headers, ORIGIN)).toEqual({
      headers,
      enforced: false,
      changed: false,
    });
  });

  it("does not count a report-only policy as enforced", () => {
    expect(
      allowOriginInPolicyHeaders(
        { "content-security-policy-report-only": ["script-src 'self'"] },
        ORIGIN,
      ).enforced,
    ).toBe(false);
  });
});
