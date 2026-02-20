import type { ScrapedPage } from "../db/schema.js";

export interface ScrapeOptions {
  urls: string[];
  maxPages: number;
  firecrawlApiKey?: string;
}

export interface ScrapeResult {
  pages: ScrapedPage[];
}

export async function scrapeUrls(options: ScrapeOptions): Promise<ScrapeResult> {
  const { urls, maxPages, firecrawlApiKey } = options;
  const allPages: ScrapedPage[] = [];

  for (const url of urls) {
    if (allPages.length >= maxPages) break;

    const remaining = maxPages - allPages.length;
    const pages = await scrapeUrl(url, remaining, firecrawlApiKey);
    allPages.push(...pages);
  }

  return { pages: allPages.slice(0, maxPages) };
}

async function scrapeUrl(
  baseUrl: string,
  maxPages: number,
  firecrawlApiKey?: string
): Promise<ScrapedPage[]> {
  // Try sitemap first
  const sitemapUrls = await fetchSitemap(baseUrl);
  let pageUrls: string[];

  if (sitemapUrls.length > 0) {
    pageUrls = rankPages(sitemapUrls, maxPages);
  } else {
    // Fallback: scrape root page and extract links
    const rootPage = await fetchPage(baseUrl, firecrawlApiKey);
    if (!rootPage) return [];

    const links = extractLinks(rootPage.content, baseUrl);
    const otherUrls = rankPages(links, maxPages - 1);
    pageUrls = [baseUrl, ...otherUrls];
  }

  const pages: ScrapedPage[] = [];
  for (const url of pageUrls.slice(0, maxPages)) {
    const page = await fetchPage(url, firecrawlApiKey);
    if (page) pages.push(page);
  }

  return pages;
}

export async function fetchSitemap(baseUrl: string): Promise<string[]> {
  try {
    const sitemapUrl = new URL("/sitemap.xml", baseUrl).href;
    const res = await fetch(sitemapUrl);
    if (!res.ok) return [];

    const text = await res.text();
    const urls: string[] = [];
    const locRegex = /<loc>(.*?)<\/loc>/g;
    let match;
    while ((match = locRegex.exec(text)) !== null) {
      urls.push(match[1]);
    }
    return urls;
  } catch {
    return [];
  }
}

export async function fetchPage(
  url: string,
  firecrawlApiKey?: string
): Promise<ScrapedPage | null> {
  try {
    if (firecrawlApiKey) {
      return await fetchWithFirecrawl(url, firecrawlApiKey);
    }
    return await fetchDirect(url);
  } catch {
    return null;
  }
}

async function fetchWithFirecrawl(
  url: string,
  apiKey: string
): Promise<ScrapedPage | null> {
  const res = await fetch("https://api.firecrawl.dev/v1/scrape", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      url,
      formats: ["markdown"],
    }),
  });

  if (!res.ok) {
    // Fallback to direct fetch
    return fetchDirect(url);
  }

  const data = (await res.json()) as {
    success: boolean;
    data?: { markdown?: string; metadata?: { title?: string } };
  };

  if (!data.success || !data.data?.markdown) {
    return fetchDirect(url);
  }

  return {
    url,
    title: data.data.metadata?.title || url,
    content: data.data.markdown.slice(0, 5000),
    scrapedAt: new Date().toISOString(),
  };
}

async function fetchDirect(url: string): Promise<ScrapedPage | null> {
  const res = await fetch(url, {
    headers: { "User-Agent": "HumanService/1.0" },
  });
  if (!res.ok) return null;

  const html = await res.text();
  const title = extractTitle(html);
  const content = htmlToText(html).slice(0, 5000);

  return {
    url,
    title,
    content,
    scrapedAt: new Date().toISOString(),
  };
}

function extractTitle(html: string): string {
  const match = /<title[^>]*>(.*?)<\/title>/is.exec(html);
  return match ? match[1].trim() : "";
}

function htmlToText(html: string): string {
  return html
    .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, "")
    .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, "")
    .replace(/<nav[^>]*>[\s\S]*?<\/nav>/gi, "")
    .replace(/<footer[^>]*>[\s\S]*?<\/footer>/gi, "")
    .replace(/<header[^>]*>[\s\S]*?<\/header>/gi, "")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/\s+/g, " ")
    .trim();
}

export function extractLinks(content: string, baseUrl: string): string[] {
  const linkRegex = /href=["'](.*?)["']/gi;
  const links = new Set<string>();
  let match;

  while ((match = linkRegex.exec(content)) !== null) {
    try {
      const resolved = new URL(match[1], baseUrl).href;
      const base = new URL(baseUrl);
      const link = new URL(resolved);
      // Only same-host links
      if (link.hostname === base.hostname && !resolved.match(/\.(jpg|png|gif|css|js|pdf|zip)$/i)) {
        links.add(resolved);
      }
    } catch {
      // Skip invalid URLs
    }
  }

  return Array.from(links);
}

export function rankPages(urls: string[], max: number): string[] {
  const scored = urls.map((url) => {
    let score = 0;
    const lower = url.toLowerCase();
    if (lower.endsWith("/") || lower.match(/\/?$/)) score += 3;
    if (lower.includes("/about")) score += 5;
    if (lower.includes("/bio")) score += 5;
    if (lower.includes("/team")) score += 3;
    if (lower.includes("/blog")) score += 2;
    if (lower.includes("/portfolio")) score += 2;
    if (lower.includes("/speaking")) score += 2;
    if (lower.includes("/work")) score += 2;
    // Penalize deep paths
    const pathDepth = (url.split("/").length - 3);
    score -= pathDepth;
    return { url, score };
  });

  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, max).map((s) => s.url);
}
