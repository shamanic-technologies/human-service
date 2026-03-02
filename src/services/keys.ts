const KEY_SERVICE_URL = process.env.KEY_SERVICE_URL;
const KEY_SERVICE_API_KEY = process.env.KEY_SERVICE_API_KEY;

interface CallerContext {
  method: string;
  path: string;
}

export interface ResolvedKey {
  key: string;
  keySource: "platform" | "org";
}

export async function resolveApiKey(
  provider: string,
  params: { orgId: string; userId: string },
  callerContext: CallerContext
): Promise<ResolvedKey | null> {
  if (!KEY_SERVICE_URL || !KEY_SERVICE_API_KEY) return null;

  try {
    const qs = new URLSearchParams({
      orgId: params.orgId,
      userId: params.userId,
    });
    const endpoint = `${KEY_SERVICE_URL}/keys/${provider}/decrypt?${qs}`;

    const res = await fetch(endpoint, {
      headers: {
        "x-api-key": KEY_SERVICE_API_KEY,
        "x-caller-service": "human",
        "x-caller-method": callerContext.method,
        "x-caller-path": callerContext.path,
      },
    });

    if (!res.ok) return null;
    const data = (await res.json()) as {
      key: string;
      keySource: "platform" | "org";
    };
    return { key: data.key, keySource: data.keySource };
  } catch {
    return null;
  }
}
