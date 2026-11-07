import { describe, expect, it } from "vite-plus/test";
import { ForkWsRpcGroup, OfficialWsRpcGroup, WS_METHODS } from "@t3tools/contracts";

import authorizedUpstreamWsRpcTags from "./authorizedUpstreamWsRpcTags.json" with { type: "json" };
import { mountedOtherWsRpcTags, mountedServerWsRpcTags, mountedSplitWsRpcTags } from "./ws.ts";

const connMainAlreadyMountedExtras = [
  WS_METHODS.desktopTabRegister,
  WS_METHODS.desktopTabRequests,
  WS_METHODS.desktopTabRespond,
] as const;

describe("mounted server WS RPCs", () => {
  it("matches OfficialWsRpcGroup and does not mount ForkWsRpcGroup", () => {
    const mounted = new Set(mountedServerWsRpcTags);
    const official = new Set(OfficialWsRpcGroup.requests.keys());
    const splitAndOther = new Set([...mountedSplitWsRpcTags, ...mountedOtherWsRpcTags]);

    expect(mounted).toEqual(official);
    expect(splitAndOther).toEqual(mounted);
    expect(mountedSplitWsRpcTags.length + mountedOtherWsRpcTags.length).toBe(
      mountedServerWsRpcTags.length,
    );

    for (const tag of ForkWsRpcGroup.requests.keys()) {
      expect(mounted.has(tag)).toBe(false);
    }
    expect(mounted.has(WS_METHODS.orbitWorkspacesSubscribe)).toBe(false);
    expect(mounted.has(WS_METHODS.orbitWorkspacesRegister)).toBe(false);
    expect(mounted.has(WS_METHODS.orbitWorkspacesRemove)).toBe(false);
  });

  it("adds only Conn main desktop tab relay methods beyond upstream 240446e2", () => {
    const authorized = new Set([...authorizedUpstreamWsRpcTags, ...connMainAlreadyMountedExtras]);
    expect(new Set(mountedServerWsRpcTags)).toEqual(authorized);
    expect(authorizedUpstreamWsRpcTags).not.toContain(WS_METHODS.desktopTabRegister);
    expect(authorizedUpstreamWsRpcTags).not.toContain(WS_METHODS.desktopTabRequests);
    expect(authorizedUpstreamWsRpcTags).not.toContain(WS_METHODS.desktopTabRespond);
  });
});
