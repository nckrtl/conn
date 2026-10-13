import type { SFSymbol } from "expo-symbols";
import { SymbolView as ExpoSymbolView } from "expo-symbols";
import { withUniwind } from "uniwind";
import type { AppSymbolViewProps } from "./AppSymbol";

export type { SFSymbol } from "expo-symbols";
export type { AppSymbolName } from "./AppSymbol";

// Conn: every name goes through expo-symbols, including the git and diff names
// upstream drew with Tabler. The conn-symbols module returns Conn's Phosphor
// symbol for the names in modules/conn-symbols/symbols.json.
function AppSymbolView(props: AppSymbolViewProps) {
  const name = typeof props.name === "string" ? props.name : props.name.ios;
  return <ExpoSymbolView {...props} name={name as SFSymbol} />;
}

export const SymbolView = withUniwind(AppSymbolView);
