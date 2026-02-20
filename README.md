# human-service

Scrapes and caches a person's online presence (websites, LinkedIn, blog, etc.) to provide writing context for AI content generation. Like brand-service, but for individuals.

## Endpoints

- `POST /profiles` — Create or update a profile (upserts by appId + orgId)
- `GET /profiles/:orgId` — Get cached profile (returns `isStale: true` if cache expired)
- `POST /profiles/:orgId/scrape` — Trigger scrape + AI extraction
- `GET /health` — Health check
- `GET /openapi.json` — OpenAPI spec

## Setup

```bash
cp .env.example .env
npm install
npm run db:push
npm run dev
```

## Testing

```bash
npm test
```
