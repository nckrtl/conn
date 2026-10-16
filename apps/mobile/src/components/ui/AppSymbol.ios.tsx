import type { SFSymbol } from "expo-symbols";
import { SymbolView as ExpoSymbolView } from "expo-symbols";
import { withUniwind } from "uniwind";
import connSymbols from "../../../modules/conn-symbols/symbols.json";
import type { AppSymbolViewProps } from "./AppSymbol";
import { useConnSymbolScope } from "../ConnSymbolScope";

export type { SFSymbol } from "expo-symbols";
export type { AppSymbolName } from "./AppSymbol";

// Conn: every name goes through expo-symbols, including the git and diff names
// upstream drew with Tabler. Inside a ConnSymbolScope, mapped names get the
// `conn.` prefix, for which the conn-symbols module returns Conn's Phosphor
// symbol; everywhere else they stay SF Symbols.
function AppSymbolView(props: AppSymbolViewProps) {
  const scoped = useConnSymbolScope();
  const name = typeof props.name === "string" ? props.name : props.name.ios;
  const resolved = scoped && Object.hasOwn(connSymbols, name) ? `conn.${name}` : name;
  return <ExpoSymbolView {...props} name={resolved as SFSymbol} />;
}

export const SymbolView = withUniwind(AppSymbolView);
