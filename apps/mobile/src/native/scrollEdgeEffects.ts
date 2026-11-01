// Avoid RN/navigation imports so node checks do not load their untranspiled Flow.

export type NativeTopScrollEdgeEffect = "automatic" | "soft";
export type NativeHeaderScrollEdgeEffects = {
  readonly top: NativeTopScrollEdgeEffect;
  readonly bottom: "hidden";
  readonly left: "hidden";
  readonly right: "hidden";
};

function nativeTopScrollEdgeEffect(
  os: string,
  _version: number | string,
): NativeTopScrollEdgeEffect {
  if (os !== "ios") {
    return "automatic";
  }

  // On iOS 27, soft uses a local overlay rather than sampling edge-to-edge app content.
  return "automatic";
}

export function nativeHeaderScrollEdgeEffects(
  os: string,
  version: number | string,
): NativeHeaderScrollEdgeEffects {
  return {
    top: nativeTopScrollEdgeEffect(os, version),
    bottom: "hidden",
    left: "hidden",
    right: "hidden",
  };
}

// nckrtl shell: the iPhone workspace lists (Threads, Pulls) scroll under the bottom toolbar too,
// so they blur at the bottom edge the same way as under the header.
export function nativeWorkspaceListScrollEdgeEffects(os: string, version: number | string) {
  const edge: NativeTopScrollEdgeEffect =
    os === "ios" && Number.parseInt(String(version), 10) < 27 ? "soft" : "automatic";
  return { top: edge, bottom: edge, left: "hidden", right: "hidden" } as const;
}
