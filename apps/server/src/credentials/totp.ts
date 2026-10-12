// @effect-diagnostics-next-line nodeBuiltinImport:off -- Effect's Crypto has no createHmac.
import * as NodeCrypto from "node:crypto";

/** A one-time code setup: from a base32 secret or an otpauth:// URI. */
export interface TotpSetup {
  readonly secret: Uint8Array;
  readonly digits: number;
  readonly periodSeconds: number;
  readonly algorithm: "sha1" | "sha256" | "sha512";
}

const BASE32 = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

function decodeBase32(text: string): Uint8Array | null {
  const clean = text.replace(/[\s=-]/g, "").toUpperCase();
  if (clean.length === 0) return null;
  let bits = 0;
  let value = 0;
  const bytes: number[] = [];
  for (const char of clean) {
    const index = BASE32.indexOf(char);
    if (index < 0) return null;
    value = (value << 5) | index;
    bits += 5;
    if (bits >= 8) {
      bytes.push((value >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }
  return Uint8Array.from(bytes);
}

/** Parses a base32 secret or an otpauth://totp URI. Null when it is neither. */
export function parseTotpSetup(input: string): TotpSetup | null {
  const trimmed = input.trim();
  if (/^otpauth:\/\//i.test(trimmed)) {
    let url: URL;
    try {
      url = new URL(trimmed);
    } catch {
      return null;
    }
    if (url.host.toLowerCase() !== "totp") return null;
    const secret = decodeBase32(url.searchParams.get("secret") ?? "");
    const digits = Number(url.searchParams.get("digits") ?? 6);
    const period = Number(url.searchParams.get("period") ?? 30);
    const algorithm = (url.searchParams.get("algorithm") ?? "SHA1").toLowerCase();
    if (
      !secret ||
      ![6, 7, 8].includes(digits) ||
      !Number.isInteger(period) ||
      period <= 0 ||
      (algorithm !== "sha1" && algorithm !== "sha256" && algorithm !== "sha512")
    ) {
      return null;
    }
    return { secret, digits, periodSeconds: period, algorithm };
  }
  const secret = decodeBase32(trimmed);
  return secret ? { secret, digits: 6, periodSeconds: 30, algorithm: "sha1" } : null;
}

/** RFC 6238 time-based one-time code for `nowMillis`. */
export function totpCode(setup: TotpSetup, nowMillis: number): string {
  const counter = Math.floor(nowMillis / 1000 / setup.periodSeconds);
  const message = Buffer.alloc(8);
  message.writeBigUInt64BE(BigInt(counter));
  const digest = NodeCrypto.createHmac(setup.algorithm, setup.secret).update(message).digest();
  const offset = digest[digest.length - 1]! & 0x0f;
  const binary =
    ((digest[offset]! & 0x7f) << 24) |
    (digest[offset + 1]! << 16) |
    (digest[offset + 2]! << 8) |
    digest[offset + 3]!;
  return String(binary % 10 ** setup.digits).padStart(setup.digits, "0");
}
