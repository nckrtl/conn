import { describe, expect, it, vi } from "vite-plus/test";

import { render, stubGlobal } from "../../test/render";
import { OrbitProfileSync } from "./OrbitProfileSync";

describe("OrbitProfileSync", () => {
  it("removes the old opt-out and backup keys once the sync starts, and no other key", async () => {
    window.localStorage.clear();
    const kept = {
      "t3code:orbit-profile-sections:v1": '{"profileId":1}',
      "t3code:orbit-profile-sync:v1": "{}",
      "unrelated:key": "stays",
    };
    for (const [key, value] of Object.entries(kept)) window.localStorage.setItem(key, value);
    const removed = ["t3code:orbit-profile-sync-opt-out:v1", "t3code:orbit-profile-sync-backup:v1"];
    for (const key of removed) window.localStorage.setItem(key, "true");
    using _bridge = stubGlobal("desktopBridge", {
      orbitGatewaySend: vi.fn(async () => ({ status: 0, body: null, error: "offline" })),
    });

    await using _screen = await render(<OrbitProfileSync />, { router: false }); // no routes used

    const seeded = [...Object.keys(kept), ...removed];
    expect(
      Object.fromEntries(seeded.map((key) => [key, window.localStorage.getItem(key)])),
    ).toEqual({ ...kept, ...Object.fromEntries(removed.map((key) => [key, null])) });
  });
});
