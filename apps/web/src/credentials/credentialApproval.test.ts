import { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import {
  hostOf,
  originOf,
  readCurrentCredentialApproval,
  requestCredentialApproval,
  respondToCredentialApproval,
  updateCredentialApproval,
} from "./credentialApproval";

const request = {
  itemTitle: "GitHub",
  providerLabel: "Vault",
  origin: "https://github.com",
  field: "password" as const,
};
const threadRef = {
  environmentId: EnvironmentId.make("environment-1"),
  threadId: ThreadId.make("thread-1"),
};

describe("credential approval queue", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("shows prompts one at a time and resolves each with the user's answer", async () => {
    const first = requestCredentialApproval(request, threadRef, Date.now() + 60_000);
    const second = requestCredentialApproval(
      { ...request, field: "otp" },
      threadRef,
      Date.now() + 60_000,
    );
    expect(readCurrentCredentialApproval()?.field).toBe("password");
    respondToCredentialApproval(first.id, true);
    await expect(first.answer).resolves.toEqual({ approved: true, reason: "user" });
    expect(readCurrentCredentialApproval()?.field).toBe("otp");
    respondToCredentialApproval(second.id, false);
    await expect(second.answer).resolves.toEqual({ approved: false, reason: "user" });
    expect(readCurrentCredentialApproval()).toBeNull();
  });

  it("returns the fields a sign-in prompt allowed", async () => {
    const prompt = requestCredentialApproval(
      { ...request, signInFields: ["username", "password", "otp"] },
      threadRef,
      Date.now() + 60_000,
    );
    respondToCredentialApproval(prompt.id, true, ["username", "password"]);
    await expect(prompt.answer).resolves.toEqual({
      approved: true,
      fields: ["username", "password"],
      reason: "user",
    });
  });

  it("denies a prompt nobody answers by its deadline", async () => {
    const prompt = requestCredentialApproval(request, threadRef, Date.now() + 5_000);
    vi.advanceTimersByTime(5_000);
    await expect(prompt.answer).resolves.toEqual({ approved: false, reason: "timeout" });
    expect(readCurrentCredentialApproval()).toBeNull();
  });

  it("adds the page's field label to a waiting prompt only", async () => {
    const prompt = requestCredentialApproval(request, threadRef, Date.now() + 60_000);
    updateCredentialApproval(prompt.id, { highlighted: true, pageFieldLabel: "Passcode" });
    expect(readCurrentCredentialApproval()).toMatchObject({
      highlighted: true,
      pageFieldLabel: "Passcode",
    });
    respondToCredentialApproval(prompt.id, false);
    await prompt.answer;
    updateCredentialApproval(prompt.id, { highlighted: false, pageFieldLabel: null });
    expect(readCurrentCredentialApproval()).toBeNull();
  });
});

describe("originOf", () => {
  it("returns only web origins", () => {
    expect(originOf("https://github.com/login?x=1")).toBe("https://github.com");
    expect(originOf("about:blank")).toBeNull();
    expect(originOf(null)).toBeNull();
    expect(hostOf("https://github.com")).toBe("github.com");
  });
});
