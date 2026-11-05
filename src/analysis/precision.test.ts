import { describe, expect, it } from 'vitest';
import { load } from 'cheerio';
import type { AuditContext } from '../types.js';
import { canonicalMismatchRule } from '../rules/js/canonical-mismatch.js';
import { canonicalValidRule } from '../rules/core/canonical-valid.js';
import { hreflangRule } from '../rules/i18n/hreflang.js';
import { validHreflang, headerAlternates } from './hreflang.js';
import { parseSitemapEntries } from '../crawler/sitemap.js';
import { prepareDuplicateComparisons } from './content-duplicates.js';
import { duplicateExactRule } from '../rules/content/duplicate-exact.js';
import { duplicateNearRule } from '../rules/content/duplicate-near.js';
import { renderedContentRule } from '../rules/js/rendered-content.js';
import { readPageFacts } from '../score-caps.js';
import { hreflangConflictingRule } from '../rules/i18n/hreflang-conflicting.js';
import { hreflangMultipleMethodsRule } from '../rules/i18n/hreflang-multiple-methods.js';
import { hreflangIncomingInvalidRule } from '../rules/i18n/hreflang-incoming-invalid.js';

const context = (html: string, url = 'https://example.com/page'): AuditContext => ({ url, html, $: load(html), headers: {}, statusCode: 200, responseTime: 1, cwv: {}, links: [], images: [], invalidLinks: [], specialLinks: [], figures: [], inlineSvgs: [], pictureElements: [] });
const canonical = (href: string) => `<html><head><link rel="canonical" href="${href}"></head><body></body></html>`;
const copy = (prefix: string, length: number) => Array.from({ length }, (_, i) => `${prefix}${i}`).join(' ');

describe('canonical URL semantics', () => {
  it('compares resolved relative/absolute URLs and ignores fragments', async () => {
    const page = context(canonical('/preferred#section'));
    page.rendered$ = load(canonical('https://example.com/preferred'));
    expect((await canonicalMismatchRule.run(page)).status).toBe('pass');
    expect((await canonicalValidRule.run(page)).status).toBe('warn');
  });
  it('keeps trailing slashes and query values significant', async () => {
    for (const href of ['https://example.com/preferred/', 'https://example.com/preferred?variant=1']) {
      const page = context(canonical('/preferred')); page.rendered$ = load(canonical(href));
      expect((await canonicalMismatchRule.run(page)).status).toBe('fail');
    }
  });
  it('resolves each DOM against its own HTML base and needs rendered data', async () => {
    const page = context(canonical('preferred').replace('<head>', '<head><base href="https://example.com/docs/">'));
    expect((await canonicalMismatchRule.run(page)).status).toBe('not-measured');
    expect((await canonicalValidRule.run(page)).details?.resolvedCanonical).toBe('https://example.com/docs/preferred');
    page.rendered$ = load(canonical('https://example.com/docs/preferred'));
    expect((await canonicalMismatchRule.run(page)).status).toBe('pass');
    expect((await canonicalValidRule.run(context(canonical('javascript:alert(1)')))).status).toBe('fail');
  });
});

describe('hreflang declarations', () => {
  it('accepts case and script variants and rejects unknown codes', () => {
    for (const code of ['en-us', 'EN-US', 'zh-Hant', 'zh-Hans-US', 'X-DEFAULT']) expect(validHreflang(code), code).toBe(true);
    for (const code of ['xx', 'en-UK', 'en-USA', 'zh-Abcd', 'en-123']) expect(validHreflang(code), code).toBe(false);
  });
  it('validates header declarations instead of passing on a keyword', async () => {
    const page = context('');
    page.headers.link = '<https://example.com/page>; rel="alternate"; hreflang="EN-us"';
    expect((await hreflangRule.run(page)).status).toBe('pass');
    page.headers.link = '<https://example.com/page>; rel="alternate"; hreflang="en-USA"';
    expect((await hreflangRule.run(page)).status).toBe('fail');
    page.headers.link = '<javascript:bad>; rel="alternate"; hreflang="x-default"';
    expect((await hreflangRule.run(page)).status).toBe('fail');
    expect(headerAlternates('<https://example.com/a,b>; rel="alternate"; hreflang="en"')).toHaveLength(1);
  });
  it('reads sitemap alternates, allows matching methods, and reports conflicts', async () => {
    const page = context('<link rel="alternate" hreflang="en" href="https://example.com/page">');
    page.sitemapEntries = parseSitemapEntries('<urlset xmlns:xhtml="http://www.w3.org/1999/xhtml"><url><loc>https://example.com/page</loc><xhtml:link rel="alternate" hreflang="en" href="https://example.com/page"/></url></urlset>');
    expect(page.sitemapEntries[0].alternates).toEqual([{ hreflang: 'en', href: page.url }]);
    expect((await hreflangRule.run(page)).status).toBe('pass');
    expect((await hreflangMultipleMethodsRule.run(page)).status).toBe('pass');
    page.headers.link = '<https://example.com/other>; rel="alternate"; hreflang="en"';
    expect((await hreflangRule.run(page)).status).toBe('fail');
    expect((await hreflangConflictingRule.run(page)).status).toBe('fail');
    expect((await hreflangMultipleMethodsRule.run(page)).status).toBe('warn');
  });
  it('validates x-default URLs and detects case-insensitive duplicates', async () => {
    expect((await hreflangRule.run(context('<link rel="alternate" hreflang="x-default" href="/relative">'))).status).toBe('fail');
    expect((await hreflangRule.run(context('<link rel="alternate" hreflang="en-US" href="https://example.com/page"><link rel="alternate" hreflang="en-us" href="https://example.com/page">'))).status).toBe('fail');
  });
  it('supports shared regional/catchall URLs and script codes in incoming graph checks', async () => {
    const page = context('<link rel="alternate" hreflang="en" href="https://example.com/page"><link rel="alternate" hreflang="en-US" href="https://example.com/page">');
    expect((await hreflangConflictingRule.run(page)).status).toBe('pass');
    page.site = { normalize: (url: string) => url, pages: new Map([['https://example.com/other', { hreflangOut: { 'zh-Hant': page.url } }]]) } as unknown as AuditContext['site'];
    expect((await hreflangIncomingInvalidRule.run(page)).status).toBe('pass');
  });
});

describe('complete-crawl duplicate evidence', () => {
  const pages = (texts: string[]) => texts.map((text, i) => ({ ...context(`<nav>Menu ${i}</nav><main>${text}</main>`, `https://example.com/${i}`), site: {} as AuditContext['site'] }));
  it('scores every duplicate member identically regardless of crawl order', async () => {
    const text = copy('word', 160);
    for (const reverse of [false, true]) {
      const batch = pages([text, text, copy('different', 160)]); if (reverse) batch.reverse();
      prepareDuplicateComparisons(batch);
      const results = new Map(await Promise.all(batch.map(async (page) => [page.url, await duplicateExactRule.run(page)] as const)));
      expect(results.get('https://example.com/0')?.status).toBe('fail');
      expect(results.get('https://example.com/1')?.status).toBe('fail');
      expect(results.get('https://example.com/2')?.status).toBe('pass');
      expect(results.get('https://example.com/0')?.details?.clusterUrls).toEqual(['https://example.com/0', 'https://example.com/1']);
    }
  });
  it('compares beyond the first 500 words and labels similarity as an estimate', async () => {
    const prefix = copy('shared', 600);
    const batch = pages([`${prefix} ${copy('alpha', 1200)}`, `${prefix} ${copy('beta', 1200)}`]);
    prepareDuplicateComparisons(batch);
    for (const page of batch) expect(await duplicateNearRule.run(page)).toMatchObject({ status: 'pass', confidence: 'heuristic' });
    const identical = pages([prefix, prefix]); prepareDuplicateComparisons(identical);
    expect((await duplicateNearRule.run(identical[0])).status).toBe('fail');
    expect((await duplicateNearRule.run(identical[1])).details?.mostSimilarUrl).toBe(identical[0].url);
  });
  it('does not certify uniqueness without two comparable pages', async () => {
    const batch = pages([copy('word', 160)]); prepareDuplicateComparisons(batch);
    expect((await duplicateExactRule.run(batch[0])).status).toBe('not-measured');
    expect((await duplicateNearRule.run(batch[0])).status).toBe('not-measured');
  });
});

describe('render completeness', () => {
  it('does not call empty raw/rendered copy mostly server rendered', async () => {
    const page = context('<div id="root"></div>'); page.rendered$ = load(page.html);
    expect((await renderedContentRule.run(page)).status).toBe('not-measured');
  });
  it('does not cap incomplete render evidence as a contentless page', async () => {
    const page = context('<title>Deferred app</title><main>Loading...</main>');
    page.rendered$ = load(page.html); page.renderQuality = { state: 'incomplete', waitedMs: 5000, contentCharacters: 10, reason: 'Not ready' };
    expect(readPageFacts(page).mainContentWords).toBeNull();
    expect((await renderedContentRule.run(page)).status).toBe('not-measured');
  });
});
