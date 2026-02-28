const KEY_SERVICE_URL = process.env.KEY_SERVICE_URL;
const KEY_SERVICE_API_KEY = process.env.KEY_SERVICE_API_KEY;

export async function resolveApiKey(
  provider: string,
  keySource: "app" | "byok",
  appId: string,
  orgId: string,
  userId: string
): Promise<string | null> {
  if (!KEY_SERVICE_URL || !KEY_SERVICE_API_KEY) return null;

  try {
    const params = new URLSearchParams({ appId, orgId, userId });
    const endpoint =
      keySource === "app"
        ? `${KEY_SERVICE_URL}/internal/app-keys/${provider}/decrypt?${params}`
        : `${KEY_SERVICE_URL}/internal/keys/${provider}/decrypt?${params}`;

    const res = await fetch(endpoint, {
      headers: { "x-api-key": KEY_SERVICE_API_KEY },
    });

    if (!res.ok) return null;
    const data = (await res.json()) as { key: string };
    return data.key;
  } catch {
    return null;
  }
}
