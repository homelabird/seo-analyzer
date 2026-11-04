import type { AuditContext } from '../../types.js';
import { registerResettable } from '../registry.js';
import { sanitizeForOutput } from '../../sanitize.js';
import { defineRule, pass, warn, notMeasured } from '../define-rule.js';

let lastStats = { crawledUrlCount: 0, sitemapUrlCount: 0, orphanUrls: [] as string[] };
/** Reset the compatibility summary; verdicts never read this state. */
export function resetOrphanRegistry(): void { lastStats = { crawledUrlCount: 0, sitemapUrlCount: 0, orphanUrls: [] }; }
registerResettable(resetOrphanRegistry);
/** Last graph's candidates, retained for callers of the previous registry API. */
export function getOrphanStats(): typeof lastStats { return sanitizeForOutput({ ...lastStats, orphanUrls: [...lastStats.orphanUrls] }); }

/** Compare the sitemap against a finished link graph, never an accumulating page registry. */
export const sitemapOrphanUrlsRule = defineRule({
  id: 'crawl-sitemap-orphan-urls',
  name: 'Sitemap Orphan URLs',
  description: 'Checks sitemap URLs for missing inbound links in a completed crawl',
  category: 'crawl',
  weight: 7,
  run: (context: AuditContext) => {
    const { site, sitemapUrls } = context;
    if (!site || !sitemapUrls?.length) {
      return notMeasured('crawl-sitemap-orphan-urls', 'Orphan detection needs a crawl graph and a sitemap URL inventory');
    }
    const orphans = [...new Set(sitemapUrls.map(site.normalize))].filter((url) =>
      url !== site.entryUrl && !site.inboundLinksByUrl.get(url)?.size);
    lastStats = { crawledUrlCount: site.pageCount, sitemapUrlCount: new Set(sitemapUrls.map(site.normalize)).size, orphanUrls: orphans };
    const details = {
      crawledUrlCount: site.pageCount,
      sitemapUrlCount: new Set(sitemapUrls.map(site.normalize)).size,
      candidateCount: orphans.length,
      candidateUrls: orphans.slice(0, 10),
      complete: site.coverage?.complete === true,
    };
    const inventoryMissing = sitemapUrls.some((url) => !site.pages?.has(site.normalize(url)));
    if (!site.coverage?.complete || inventoryMissing || context.sitemapTruncated || (context.sitemapSkippedCount ?? 0) > 0) {
      return notMeasured('crawl-sitemap-orphan-urls', 'Crawl or sitemap coverage is partial; URLs without observed inbound links are candidates, not confirmed orphans', details);
    }
    if (orphans.length) {
      return warn('crawl-sitemap-orphan-urls', `${orphans.length} sitemap URL(s) have no inbound links in the completed crawl`, {
        ...details, orphanCount: orphans.length, orphanUrls: orphans.slice(0, 10),
      });
    }
    return pass('crawl-sitemap-orphan-urls', 'All sitemap URLs have inbound links or are the crawl entry', { ...details, orphanCount: 0 });
  },
});
