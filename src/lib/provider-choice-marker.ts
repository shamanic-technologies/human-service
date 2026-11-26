// AUDIENCE-SOURCE-BY-FIT-1126: the marker a split birth writes on `audiences.chooser_trace`
// (`providerChoice.status = "pending"`): this audience's provider is MEASURED before it is used
// (src/services/audience-provider-choice.ts). Dependency-free so the split can write it.

export interface ProviderChoiceMarker {
  status: "pending" | "decided";
  since?: string;
}

export function pendingProviderChoice(): Record<string, unknown> {
  return { providerChoice: { status: "pending", since: new Date().toISOString() } satisfies ProviderChoiceMarker };
}

export function readProviderChoice(row: { chooserTrace: unknown }): (ProviderChoiceMarker & Record<string, unknown>) | null {
  const t = row.chooserTrace as Record<string, unknown> | null;
  const c = t?.providerChoice as (ProviderChoiceMarker & Record<string, unknown>) | undefined;
  return c && typeof c === "object" && typeof c.status === "string" ? c : null;
}

export function providerChoicePending(row: { chooserTrace: unknown }): boolean {
  return readProviderChoice(row)?.status === "pending";
}
