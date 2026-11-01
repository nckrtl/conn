import { Platform } from "react-native";

// nckrtl shell: the iPhone has no tab bar to leave Settings by, so Settings opens as a page
// sheet over the workspace and its pages push inside it. iPad keeps Settings in its columns.
export const SETTINGS_OPENS_AS_SHEET = Platform.OS === "ios" && !Platform.isPad;
