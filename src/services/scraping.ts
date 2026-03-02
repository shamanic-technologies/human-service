const SCRAPING_SERVICE_URL = process.env.SCRAPING_SERVICE_URL;
const SCRAPING_SERVICE_API_KEY = process.env.SCRAPING_SERVICE_API_KEY;

interface ScrapingTracking {
  orgId?: string;
  parentRunId?: string;
  userId?: string;
}

export interface MapResult {
  urls: string[];
}

export async function mapSiteUrls(
  url: string,
  tracking: ScrapingTracking,
  limit = 100
): Promise<MapResult> {
  if (!SCRAPING_SERVICE_URL || !SCRAPING_SERVICE_API_KEY) {
    return { urls: [url] };
  }

  try {
    const res = await fetch(`${SCRAPING_SERVICE_URL}/map`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-API-Key": SCRAPING_SERVICE_API_KEY,
      },
      body: JSON.stringify({
        url,
        limit,
        sourceOrgId: tracking.orgId,
        parentRunId: tracking.parentRunId,
        userId: tracking.userId,
      }),
    });

    if (!res.ok) return { urls: [url] };
    const data = (await res.json()) as { urls?: string[] };
    return { urls: data.urls ?? [url] };
  } catch {
    return { urls: [url] };
  }
}

export interface ScrapeResult {
  url: string;
  markdown: string;
  title: string;
}

export async function scrapePage(
  url: string,
  tracking: ScrapingTracking
): Promise<ScrapeResult | null> {
  if (!SCRAPING_SERVICE_URL || !SCRAPING_SERVICE_API_KEY) {
    return fetchDirect(url);
  }

  try {
    const res = await fetch(`${SCRAPING_SERVICE_URL}/scrape`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-API-Key": SCRAPING_SERVICE_API_KEY,
      },
      body: JSON.stringify({
        url,
        sourceService: "human-service",
        sourceOrgId: tracking.orgId,
        parentRunId: tracking.parentRunId,
        userId: tracking.userId,
      }),
    });

    if (!res.ok) return fetchDirect(url);
    const data = (await res.json()) as {
      result?: { rawMarkdown?: string; metadata?: { title?: string } };
    };
    if (!data.result?.rawMarkdown) return fetchDirect(url);

    return {
      url,
      markdown: data.result.rawMarkdown.slice(0, 15000),
      title: data.result.metadata?.title ?? url,
    };
  } catch {
    return fetchDirect(url);
  }
}

async function fetchDirect(url: string): Promise<ScrapeResult | null> {
  try {
    const res = await fetch(url, {
      headers: { "User-Agent": "HumanService/1.0" },
    });
    if (!res.ok) return null;

    const html = await res.text();
    const titleMatch = /<title[^>]*>(.*?)<\/title>/is.exec(html);
    const title = titleMatch ? titleMatch[1].trim() : url;
    const markdown = html
      .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, "")
      .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, "")
      .replace(/<nav[^>]*>[\s\S]*?<\/nav>/gi, "")
      .replace(/<footer[^>]*>[\s\S]*?<\/footer>/gi, "")
      .replace(/<[^>]+>/g, " ")
      .replace(/&nbsp;/g, " ")
      .replace(/&amp;/g, "&")
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, 15000);

    return { url, markdown, title };
  } catch {
    return null;
  }
}
