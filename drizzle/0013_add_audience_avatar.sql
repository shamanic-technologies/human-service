-- Audience avatar image. Nullable; populated by POST /orgs/audiences/{id}/avatar
-- which delegates image generation to chat-service (chat-service owns the cost)
-- and stores the returned bytes as a self-contained data: URI. No external blob
-- store, so the audience row is fully self-describing.
ALTER TABLE "audiences" ADD COLUMN IF NOT EXISTS "avatar_url" text;
