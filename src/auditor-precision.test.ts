import { afterEach, describe, expect, it, vi } from 'vitest';
import { Auditor } from './auditor.js';

afterEach(() => vi.unstubAllGlobals());
const root = 'https://example.test/';
const html = '<title>Example</title><main>Example content for a small audit page.</main>';

function network() {
  vi.stubGlobal('fetch', vi.fn(async (input: string) => {
    const url = String(input);
    if (url.endsWith('/robots.txt')) return new Response('User-agent: *\nAllow: /');
    if (url.endsWith('/sitemap.xml')) return new Response(`<urlset><url><loc>${root}orphan</loc></url></urlset>`);
    return new Response(html, { headers: { 'content-type': 'text/html' } });
  }));
}

describe('precision options through the auditor', () => {
  it('passes mobile rendering and synthetic interaction options through crawl mode', async () => {
    network();
    const browserFetcher = vi.fn(async (_url, _timeout, options) => ({ html: options?.mobile ? '<title>Mobile</title>' : html, statusCode: 200, responseTime: 1, cwv: {} }));
    const result = await new Auditor({ categories: ['mobile'], measureCwv: true, mobileParity: true, simulateInteraction: true, browserFetcher }).auditWithCrawl(root, 1, 1);
    expect(browserFetcher).toHaveBeenCalledTimes(2);
    expect(browserFetcher.mock.calls[0][2]).toMatchObject({ simulateInteraction: true });
    expect(browserFetcher.mock.calls[1][2]).toMatchObject({ mobile: true });
    expect(result.categoryResults[0].results.find((item) => item.ruleId === 'mobile-parity-title')?.status).toBe('fail');
  });

  it('connects sitemap inventory to crawl mode and records its provenance', async () => {
    network();
    const result = await new Auditor({ categories: ['crawl'], crawlSitemap: true }).auditWithCrawl(root, 5, 1);
    expect(result.coverage?.pages).toContain(`${root}orphan`);
    expect(result.run?.crawlSitemap).toBe(true);
    expect(result.categoryResults[0].results.find((item) => item.ruleId === 'crawl-sitemap-orphan-urls')?.status).toBe('warn');
  });
});
