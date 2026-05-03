// Cold-start registration. Currently registers HUMAN_SERVICE_API_KEY as a
// platform secret in key-service so other services can call this one without
// hardcoding env vars on their side.
//
// Idempotent (key-service /platform-keys is upsert). Safe to call on every boot.
// Skips silently when KEY_SERVICE_URL/KEY_SERVICE_API_KEY/HUMAN_SERVICE_API_KEY
// are unset — local dev and tests don't need it.

const SERVICE_NAME = "human-service";
const PROVIDER_KEY = "HUMAN_SERVICE_API_KEY";

export async function register(): Promise<void> {
  await registerPlatformKey();
}

async function registerPlatformKey(): Promise<void> {
  const keyServiceUrl = process.env.KEY_SERVICE_URL;
  const keyServiceApiKey = process.env.KEY_SERVICE_API_KEY;
  const humanServiceApiKey = process.env.HUMAN_SERVICE_API_KEY;

  if (!keyServiceUrl || !keyServiceApiKey || !humanServiceApiKey) {
    console.log(
      `[${SERVICE_NAME}] Skipping platform-key registration (KEY_SERVICE_URL, KEY_SERVICE_API_KEY, or HUMAN_SERVICE_API_KEY not set)`
    );
    return;
  }

  const res = await fetch(`${keyServiceUrl}/platform-keys`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-API-Key": keyServiceApiKey,
    },
    body: JSON.stringify({
      provider: PROVIDER_KEY,
      apiKey: humanServiceApiKey,
    }),
  });

  if (!res.ok) {
    const body = await res.text();
    throw new Error(
      `[${SERVICE_NAME}] Failed to register ${PROVIDER_KEY} platform key: ${res.status} ${body}`
    );
  }

  console.log(`[${SERVICE_NAME}] Registered ${PROVIDER_KEY} as platform key`);
}
