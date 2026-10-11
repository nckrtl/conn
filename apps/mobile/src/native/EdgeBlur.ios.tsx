import { requireNativeView } from "expo";
import type { ViewProps } from "react-native";

export const EdgeBlur = requireNativeView<ViewProps & { edge: "top" | "bottom" | "content" }>(
  "T3ComposerEditor",
  "EdgeBlur",
);
