export type MobileStageLabel = "Beta" | "Dev" | "Nightly";

export function resolveMobileStageLabel(appVariant: unknown): MobileStageLabel {
  if (appVariant === "development") return "Dev";
  if (appVariant === "preview") return "Nightly";
  return "Beta";
}

// iOS hands a manifest null to JS as {}, which crashes when rendered as a child.
export function resolveBrandName(brandName: unknown): string | null {
  if (typeof brandName !== "string") return null;
  const trimmed = brandName.trim();
  return trimmed.length > 0 ? trimmed : null;
}
