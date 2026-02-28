export function extractLinks(content: string, baseUrl: string): string[] {
  const linkRegex = /href=["'](.*?)["']/gi;
  const links = new Set<string>();
  let match;

  while ((match = linkRegex.exec(content)) !== null) {
    try {
      const resolved = new URL(match[1], baseUrl).href;
      const base = new URL(baseUrl);
      const link = new URL(resolved);
      if (
        link.hostname === base.hostname &&
        !resolved.match(/\.(jpg|png|gif|css|js|pdf|zip)$/i)
      ) {
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
    if (lower.includes("/methodology")) score += 4;
    if (lower.includes("/framework")) score += 4;
    if (lower.includes("/approach")) score += 4;
    if (lower.includes("/philosophy")) score += 3;
    // Penalize deep paths
    const pathDepth = url.split("/").length - 3;
    score -= pathDepth;
    return { url, score };
  });

  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, max).map((s) => s.url);
}
