import { useWindowDimensions } from "react-native";
import { useScaledTextRole } from "../settings/appearance/useScaledTextRole";
import type { HeaderBarButtonMailSearchToolbarItem } from "react-native-screens";

import { NATIVE_LIQUID_GLASS_SUPPORTED } from "../../native/native-glass";

/**
 * Group search, filtering, and composition on platforms with Liquid Glass.
 * The v5 header adapter turns this intent into UISearchController and native
 * toolbar items. Earlier iOS versions use separate search and toolbar options.
 */
export const NATIVE_MAIL_SEARCH_TOOLBAR_SUPPORTED = NATIVE_LIQUID_GLASS_SUPPORTED;

/** Clearance for scroll content that must come to rest above the floating toolbar. */
export const NATIVE_MAIL_SEARCH_TOOLBAR_CONTENT_INSET = 56;

type NativeMailSearchToolbarInput = Omit<
  HeaderBarButtonMailSearchToolbarItem,
  "type" | "useFallbackSearchField"
>;

/**
 * Describe the thread-list search and actions for the native header adapter.
 */
export function useCreateNativeMailSearchToolbarItem() {
  const { fontSize } = useScaledTextRole("body");
  const { fontScale } = useWindowDimensions();
  return (
    input: NativeMailSearchToolbarInput,
  ): HeaderBarButtonMailSearchToolbarItem & { searchFontSize: number } => ({
    placeholder: "Search",
    searchFontSize: fontSize * fontScale,
    ...input,
    type: "mailSearchToolbar",
    useFallbackSearchField: true,
  });
}
