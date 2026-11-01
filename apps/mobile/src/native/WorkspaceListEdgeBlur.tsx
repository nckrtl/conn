import { Platform } from "react-native";

import { EdgeBlur } from "./EdgeBlur";
import { NATIVE_LIQUID_GLASS_SUPPORTED } from "./native-glass";

const MARKER_STYLE = { position: "absolute", width: 0, height: 0 } as const;

/**
 * nckrtl shell: links a workspace list's scroll view to the bottom toolbar, so rows blur under
 * the toolbar as they do under the header. Render it inside the list's scroll view.
 */
export function WorkspaceListEdgeBlur() {
  if (Platform.OS !== "ios" || !NATIVE_LIQUID_GLASS_SUPPORTED) return null;
  return (
    <>
      <EdgeBlur edge="content" pointerEvents="none" style={MARKER_STYLE} />
      <EdgeBlur edge="toolbar" pointerEvents="none" style={MARKER_STYLE} />
    </>
  );
}
