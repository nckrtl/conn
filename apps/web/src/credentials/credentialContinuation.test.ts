import { describe, expect, it } from "vite-plus/test";
import { CredentialItemId, type SiteCredentialOption } from "@t3tools/contracts";
import {
  beginCredentialContinuation,
  continuationMatches,
  continuationFields,
} from "./credentialContinuation";
import { EMPTY_PAGE_FIELDS } from "./credentialPageFields";

const item: SiteCredentialOption = {
  id: CredentialItemId.make("00000000-0000-4000-8000-000000000001"),
  title: "Test login",
  username: "test@example.invalid",
  source: "vault",
};

describe("selected login continuation", () => {
  it("continues email to password to OTP once for the chosen login", () => {
    let session = beginCredentialContinuation(
      item,
      "tab-a",
      "https://id.example.com",
      ["username"],
      1000,
    );
    const passwordPage = {
      ...EMPTY_PAGE_FIELDS,
      any: true,
      password: true,
      empty: ["password" as const],
    };
    expect(continuationFields(session, passwordPage)).toEqual(["password"]);
    session = { ...session, attempted: new Set([...session.attempted, "password"]) };
    expect(continuationFields(session, passwordPage)).toEqual([]);
    const codePage = { ...EMPTY_PAGE_FIELDS, any: true, otp: true, empty: ["otp" as const] };
    expect(continuationFields(session, codePage)).toEqual(["otp"]);
    // Some sites retain the filled password input while revealing the code.
    expect(continuationFields(session, { ...codePage, password: true })).toEqual(["otp"]);
    session = { ...session, attempted: new Set([...session.attempted, "otp"]) };
    expect(continuationFields(session, codePage)).toEqual([]);
    expect(session.item.id).toBe(item.id);
  });

  it("does not overwrite a filled field or continue in another tab or origin", () => {
    const session = beginCredentialContinuation(
      item,
      "tab-a",
      "https://id.example.com",
      ["username"],
      1000,
    );
    expect(
      continuationFields(session, { ...EMPTY_PAGE_FIELDS, any: true, password: true }),
    ).toEqual([]);
    expect(continuationMatches(session, "tab-a", "https://id.example.com", 2000)).toBe(true);
    expect(continuationMatches(session, "tab-b", session.origin, 2000)).toBe(false);
    expect(continuationMatches(session, "tab-a", "https://other.example.com", 2000)).toBe(false);
    expect(continuationMatches(session, "tab-a", "http://id.example.com", 2000)).toBe(false);
    expect(continuationMatches(session, "tab-a", null, 2000)).toBe(false);
    expect(continuationMatches(session, "tab-a", session.origin, session.expiresAt)).toBe(false);
  });
});
