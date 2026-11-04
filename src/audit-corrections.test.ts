import { describe, it, expect } from 'vitest';
import { load } from 'cheerio';
import { createAuditContext } from './crawler/fetcher.js';
import { buildCategoryResult, calculateOverallScore, buildAuditResult } from './scoring.js';
import { categories } from './categories/index.js';
import { pass, notMeasured } from './rules/define-rule.js';
import { nosnippetRule } from './rules/core/nosnippet.js';
import { colorContrastRule } from './rules/a11y/color-contrast.js';
import { sslExpiryRule } from './rules/security/ssl-expiry.js';
import { sslProtocolRule } from './rules/security/ssl-protocol.js';
import { http2Rule } from './rules/perf/http2.js';
import { sitemapOrphanUrlsRule } from './rules/crawl/sitemap-orphan-urls.js';
import { normalizeRunArgs, DEFAULT_CAPABILITIES } from './dashboard/audit-session.js';
import { parseRunArgs } from './dashboard/run-api.js';
import { renderHtmlReport } from './reporters/html-reporter.js';
import { renderMarkdownReport } from './reporters/markdown-reporter.js';
import type { SiteContext } from './types.js';

const make = (html = '<p>Text</p>') => createAuditContext('https://example.com/old', { html, $: load(html), headers: {}, statusCode: 200, responseTime: 1 });

describe('document address resolution', () => {
  it('resolves links and images against final URL and first base, with document-origin scope', () => {
    const html = '<base href="https://cdn.example/assets/"><a href="child">Child</a><img src="photo.jpg">';
    const ctx = createAuditContext('https://example.com/old', { html, $: load(html), headers: {}, statusCode: 200, responseTime: 1, finalUrl: 'https://example.com/docs/' });
    expect(ctx.url).toBe('https://example.com/docs/');
    expect(ctx.requestedUrl).toBe('https://example.com/old');
    expect(ctx.links[0]?.href).toBe('https://cdn.example/assets/child');
    expect(ctx.links[0]?.isInternal).toBe(false);
    expect(ctx.images[0]?.src).toBe('https://cdn.example/assets/photo.jpg');
  });
});

describe('evidence-based verdicts', () => {
  it('distinguishes unlimited snippets from disabled snippets in meta and headers', async () => {
    expect((await nosnippetRule.run(make('<meta name="robots" content="max-snippet:-1">'))).status).toBe('pass');
    expect((await nosnippetRule.run(make('<meta name="googlebot" content="max-snippet:0">'))).status).toBe('warn');
    const ctx = make(); ctx.headers['x-robots-tag'] = 'max-snippet:-1';
    expect((await nosnippetRule.run(ctx)).status).toBe('pass');
  });
  it('measures inline contrast instead of guessing from a hex name', async () => {
    expect((await colorContrastRule.run(make('<p style="color:#ffffff;background-color:#000000">Text</p>'))).status).toBe('pass');
    expect((await colorContrastRule.run(make('<p style="color:#ffffff;background-color:#ffffff">Text</p>'))).status).toBe('warn');
    expect((await colorContrastRule.run(make('<p style="color:#ffffff">Text</p>'))).weight).toBe(0);
  });
  it('does not substitute HSTS and Alt-Svc for transport evidence', async () => {
    const ctx = make(); ctx.headers = { 'strict-transport-security': 'max-age=31536000; preload', 'alt-svc': 'h3=":443"' };
    for (const rule of [sslExpiryRule, sslProtocolRule, http2Rule]) expect((await rule.run(ctx)).weight).toBe(0);
    ctx.tls = { protocol: 'TLSv1.3', validTo: new Date(Date.now() + 90 * 86_400_000).toISOString() };
    ctx.httpProtocol = 'h2';
    for (const rule of [sslExpiryRule, sslProtocolRule, http2Rule]) expect((await rule.run(ctx)).status).toBe('pass');
    ctx.tls.validTo = new Date(Date.now() - 86_400_000).toISOString();
    expect((await sslExpiryRule.run(ctx)).status).toBe('fail');
  });
  it('excludes an entirely unmeasured category from the overall denominator', () => {
    const core = buildCategoryResult('core', [pass('core-title','ok')]);
    const perf = buildCategoryResult('perf', [notMeasured('cwv-lcp','no reading')]);
    expect(perf.measured).toBe(false);
    expect(calculateOverallScore([core,perf],categories)).toBe(100);
  });
  it('marks a wholly unmeasured audit as N/A instead of a failed site', () => {
    const perf = buildCategoryResult('perf', [notMeasured('cwv-lcp','unavailable')]);
    const result = buildAuditResult('https://example.com/', [perf], categories, new Date().toISOString());
    expect(result.measured).toBe(false);
    expect(renderHtmlReport(result)).not.toContain('✕ Audit Failed');
    expect(renderMarkdownReport(result)).not.toContain('Audit failed');
  });
  it('rejects unknown categories at both HTTP and desktop run boundaries', () => {
    expect(() => parseRunArgs({ url: 'https://example.com/', categories: ['typo'] })).toThrow();
    expect(() => normalizeRunArgs({ url: 'https://example.com/', categories: ['typo'] }, DEFAULT_CAPABILITIES)).toThrow('Unknown category');
  });
  it('uses the complete graph independent of page order, and declines partial-crawl orphan claims', async () => {
    const a = 'https://example.com/a', b = 'https://example.com/b', c = 'https://example.com/c';
    const site: SiteContext = { entryUrl: a, pageCount: 3, depthByUrl: new Map(), outboundLinksByUrl: new Map(), inboundLinksByUrl: new Map([[b,new Set([a])],[c,new Set([b])]]), normalize: (u) => u, coverage: { complete: true, limitReached: false } };
    site.pages = new Map([a,b,c].map((url) => [url, { statusCode: 200, noindex: false, nofollow: false, disallowed: false, hreflangOut: {} }]));
    const one = make(); one.url = a; one.site = site; one.sitemapUrls = [a,b,c];
    const two = { ...one, url: b };
    expect((await sitemapOrphanUrlsRule.run(one)).status).toBe('pass');
    expect((await sitemapOrphanUrlsRule.run(two)).status).toBe('pass');
    site.coverage = { complete: false, limitReached: true };
    expect((await sitemapOrphanUrlsRule.run(one)).weight).toBe(0);
  });
});
