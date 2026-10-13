import { createContext, use, type ReactNode } from "react";

const ConnSymbolScopeContext = createContext(false);

/**
 * Conn: icons inside this scope draw Conn's Phosphor symbols on iOS
 * (modules/conn-symbols). The thread feed uses it; the rest of the app and
 * native controls keep SF Symbols.
 */
export function ConnSymbolScope(props: { readonly children: ReactNode }) {
  return <ConnSymbolScopeContext value={true}>{props.children}</ConnSymbolScopeContext>;
}

export function useConnSymbolScope() {
  return use(ConnSymbolScopeContext);
}
