// Cold-start registration. Currently registers HUMAN_SERVICE_API_KEY as a
// platform secret in key-service so other services can call this one without
// hardcoding env vars on their side.
//
// Idempotent (key-service /platform-keys is upsert). Safe to call on every boot.
// Skips silently when KEY_SERVICE_URL/KEY_SERVICE_API_KEY/HUMAN_SERVICE_API_KEY
// are unset — local dev and tests don't need it.

import { describeError, isTransientConnectError, sleep } from "./lib/transient-connect.js";

const SERVICE_NAME = "human-service";
const PROVIDER_KEY = "HUMAN_SERVICE_API_KEY";

// key-service is a Railway sibling that sleeps when idle, so the first attempt
// on a deploy that lands cold rejects with `fetch failed` / ECONNREFUSED while it
// wakes. Observed on the staging deploy of 2026-07-31. Retry the CONNECT PHASE
// only — a thrown rejection, never a completed HTTP response (a non-2xx is a real
// answer from key-service and must surface as-is). Write-safe: the request never
// reached the server, and /platform-keys is an upsert.
const CONNECT_RETRY_DELAYS_MS = [250, 500, 1000, 2000, 4000];

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

  const res = await fetchWithConnectRetry(`${keyServiceUrl}/platform-keys`, {
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

async function fetchWithConnectRetry(url: string, init: RequestInit): Promise<Response> {
  for (let attempt = 0; ; attempt++) {
    try {
      return await fetch(url, init);
    } catch (err) {
      const delay = CONNECT_RETRY_DELAYS_MS[attempt];
      if (delay === undefined || !isTransientConnectError(err)) throw err;
      console.warn(
        `[${SERVICE_NAME}] key-service not reachable yet (attempt ${attempt + 1}, ` +
          `${describeError(err)}) — likely a sleeping sibling waking; retrying in ${delay}ms`
      );
      await sleep(delay);
    }
  }
}
