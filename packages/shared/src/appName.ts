// Conn: the product name in UI copy. Catalog strings say `{appName}` instead of the
// product name, and every call site passes `appName()`, so a renamed build (Conn)
// reads its own name in every language. The desktop renderer reads it from the
// desktop bridge's branding (so module-level messages get it too); mobile sets it
// from the Expo config at startup. The server imports this package and keeps the
// default. See FORK.md, "i18n and the app name".
const DEFAULT_APP_NAME = "T3 Code";

let current: string | null = null;

interface BrandingBridge {
  readonly desktopBridge?: { readonly getAppBranding?: () => { readonly baseName?: string } | null };
}

export function setAppName(name: string | null | undefined): void {
  const trimmed = name?.trim();
  current = trimmed ? trimmed : null;
}

export function appName(): string {
  if (current !== null) return current;
  const injected = (globalThis as BrandingBridge).desktopBridge?.getAppBranding?.()?.baseName?.trim();
  return injected ? injected : DEFAULT_APP_NAME;
}
