import { describe, expect, it } from 'vitest';
import { load } from 'cheerio';
import { Crawler } from './crawler.js';

describe('sitemap-seeded crawl', () => {
  function crawler(seedUrls: string[], maxPages = 10) {
    return new Crawler({ seedUrls, maxPages, concurrency: 1, respectRobots: false,
      fetchPage: async (url) => {
        const html = url.endsWith('/linked') ? '<title>Linked</title>' : '<title>Page</title><a href="/linked">Linked</a>';
        return { html, $: load(html), headers: {}, statusCode: 200, responseTime: 1 };
      },
    });
  }
  it('visits sitemap-only inventory without fabricating click depth', async () => {
    const c = crawler(['https://example.com/orphan', 'https://example.com/orphan', 'https://other.example/out', 'https://example.com/a.pdf']);
    const pages = await c.crawl('https://example.com/');
    expect(pages.map((page) => page.url)).toEqual(['https://example.com/', 'https://example.com/orphan', 'https://example.com/linked']);
    const site = c.buildSiteContext();
    expect(site.depthByUrl.has('https://example.com/orphan')).toBe(false);
    expect(site.depthByUrl.get('https://example.com/linked')).toBe(1);
    expect(site.discoverySourceByUrl?.get('https://example.com/orphan')).toEqual(new Set(['sitemap']));
    expect(site.coverage?.complete).toBe(true);
  });
  it('keeps the page limit and reports incomplete coverage', async () => {
    const c = crawler(['https://example.com/orphan'], 1);
    expect(await c.crawl('https://example.com/')).toHaveLength(1);
    expect(c.buildSiteContext().coverage).toMatchObject({ complete: false, limitReached: true });
  });
});
