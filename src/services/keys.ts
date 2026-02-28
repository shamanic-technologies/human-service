const KEY_SERVICE_URL = process.env.KEY_SERVICE_URL;
const KEY_SERVICE_API_KEY = process.env.KEY_SERVICE_API_KEY;

interface CallerContext {
  method: string;
  path: string;
}

export async function resolveApiKey(
  provider: string,
  keySource: "app" | "byok" | "platform",
  params: { appId?: string; orgId?: string },
  callerContext: CallerContext
): Promise<string | null> {
  if (!KEY_SERVICE_URL || !KEY_SERVICE_API_KEY) return null;

  try {
    let endpoint: string;
    if (keySource === "platform") {
      endpoint = `${KEY_SERVICE_URL}/internal/platform-keys/${provider}/decrypt`;
    } else if (keySource === "app") {
      const qs = new URLSearchParams({ appId: params.appId || "" });
      endpoint = `${KEY_SERVICE_URL}/internal/app-keys/${provider}/decrypt?${qs}`;
    } else {
      const qs = new URLSearchParams({ orgId: params.orgId || "" });
      endpoint = `${KEY_SERVICE_URL}/internal/keys/${provider}/decrypt?${qs}`;
    }

    const res = await fetch(endpoint, {
      headers: {
        "x-api-key": KEY_SERVICE_API_KEY,
        "X-Caller-Service": "human",
        "X-Caller-Method": callerContext.method,
        "X-Caller-Path": callerContext.path,
      },
    });

    if (!res.ok) return null;
    const data = (await res.json()) as { key: string };
    return data.key;
  } catch {
    return null;
  }
}
