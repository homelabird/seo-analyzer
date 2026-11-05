import { beforeEach, describe, expect, it } from 'vitest';
import { load } from 'cheerio';
import { createTestContext } from './rules/test-context.js';
import { countWords, tokenize } from './rules/content/utils/text-extractor.js';
import { readingLevelRule } from './rules/content/reading-level.js';
import { keywordStuffingRule } from './rules/content/keyword-stuffing.js';
import { duplicateNearRule, resetNearDuplicateRegistry } from './rules/content/duplicate-near.js';
import { contentCaps, readPageFacts } from './score-caps.js';
import { noindexMismatchRule } from './rules/js/noindex-mismatch.js';
import { soft404Rule } from './rules/technical/soft-404.js';
import { structuredDataRequiredFieldsRule } from './rules/schema/required-fields.js';
import { structuredDataArticleRule } from './rules/schema/article.js';
import { structuredDataProductRule } from './rules/schema/product.js';
import { Crawler } from './crawler/crawler.js';
import type { SiteContext } from './types.js';

const korean = '검색 엔진 최적화를 위해 유용한 정보를 제공하고 방문자의 문제를 해결합니다. 정확한 설명과 구체적인 사례를 통해 사용자에게 도움을 주는 콘텐츠를 작성합니다. '.repeat(30);
const prose = 'This tutorial explains exception handling with examples and working code. '.repeat(50);
const jsonld = (data: unknown) => `<script type="application/ld+json">${JSON.stringify(data)}</script>`;

describe('SEO precision regressions', () => {
  beforeEach(resetNearDuplicateRegistry);

  it('preserves Korean, accented Latin, Chinese, Japanese, and mixed words', () => {
    for (const text of ['검색 엔진 최적화', 'café naïve', '搜索引擎优化指南', '検索エンジン最適化', '한국어 SEO 안내']) {
      expect(countWords(text)).toBeGreaterThan(0);
    }
    expect(tokenize('café')).toEqual(['café']);
  });

  it('does not cap substantial Korean copy as zero-word content', () => {
    const facts = readPageFacts(createTestContext(`<title>검색 최적화 안내</title><main>${korean}</main>`));
    expect(facts.mainContentWords).toBeGreaterThan(20);
    expect(contentCaps(facts)).toEqual([]);
  });

  it('does not apply English readability and keyword calibration to Korean', async () => {
    const context = createTestContext(`<html lang="ko"><body>${korean}</body></html>`);
    expect((await readingLevelRule.run(context)).status).toBe('not-measured');
    expect((await keywordStuffingRule.run(context)).status).toBe('not-measured');
  });

  it('does not grade readability of an insufficient sample', async () => {
    expect((await readingLevelRule.run(createTestContext('Short text.'))).status).toBe('not-measured');
  });

  it('compares substantial Korean near duplicates', async () => {
    const context = createTestContext(`<main>${korean}</main>`, { site: {} as SiteContext });
    await duplicateNearRule.run(context);
    expect((await duplicateNearRule.run({ ...context, url: 'https://example.com/copy' })).status).toBe('fail');
  });

  it('does not report insufficient near-duplicate evidence as a pass', async () => {
    expect((await duplicateNearRule.run(createTestContext('Short', { site: {} as SiteContext }))).status).toBe('not-measured');
  });

  it('detects a Googlebot-only noindex added during rendering', async () => {
    const context = createTestContext('<meta name="robots" content="index">', {
      rendered$: load('<meta name="robots" content="index"><meta name="Googlebot" content="noindex">'),
    });
    expect((await noindexMismatchRule.run(context)).status).toBe('fail');
    expect(readPageFacts(context).noindex).toBe(true);
  });

  it('retains original noindex even when rendering removes it', () => {
    expect(readPageFacts(createTestContext('<meta name="robots" content="none">', {
      rendered$: load('<meta name="robots" content="index,follow">'),
    })).noindex).toBe(true);
  });

  it('keeps Bing-only header directives out of Google indexing facts', () => {
    const context = createTestContext('<title>Public</title>', { headers: { 'x-robots-tag': 'bingbot: nofollow, noindex' } });
    expect(readPageFacts(context).noindex).toBe(false);
  });

  it('does not classify a substantial error-handling tutorial as a soft 404', async () => {
    expect((await soft404Rule.run(createTestContext(`<title>Error handling in TypeScript</title><main>${prose}</main>`))).status).toBe('pass');
  });

  it('detects a Korean error page served with status 200', async () => {
    expect((await soft404Rule.run(createTestContext('<title>페이지를 찾을 수 없습니다</title><h1>페이지를 찾을 수 없습니다</h1><p>삭제되었거나 존재하지 않는 페이지입니다.</p>'))).status).toBe('fail');
  });

  it('does not make Article recommended properties mandatory', async () => {
    const context = createTestContext(jsonld({ '@type': 'Article', headline: 'Example' }));
    expect((await structuredDataRequiredFieldsRule.run(context)).status).toBe('warn');
    expect((await structuredDataArticleRule.run(context)).status).toBe('warn');
  });

  it('validates JSON-LD added during rendering while retaining the raw DOM', async () => {
    const context = createTestContext('<title>Client-rendered article</title>', {
      rendered$: load(jsonld({ '@type': 'Article', headline: 'Rendered article' })),
    });
    expect((await structuredDataRequiredFieldsRule.run(context)).status).toBe('warn');
    expect(context.$('script[type="application/ld+json"]').length).toBe(0);
  });

  it('validates top-level JSON-LD arrays and empty required values', async () => {
    const context = createTestContext(jsonld([{ '@type': 'Organization', name: '' }]));
    expect((await structuredDataRequiredFieldsRule.run(context)).status).toBe('fail');
  });

  it('does not penalize unsupported schema types', async () => {
    expect((await structuredDataRequiredFieldsRule.run(createTestContext(jsonld({ '@type': 'CreativeWork', name: 'Example' })))).status).toBe('not-measured');
  });

  it('accepts a rated Product snippet without an offer', async () => {
    const context = createTestContext(jsonld({ '@type': 'Product', name: 'Example', aggregateRating: { '@type': 'AggregateRating', ratingValue: 4.5, reviewCount: 20 } }));
    expect((await structuredDataProductRule.run(context)).status).not.toBe('fail');
  });

  it('accepts zero-priced offers and AggregateOffer prices', async () => {
    for (const offers of [{ '@type': 'Offer', price: 0 }, { '@type': 'AggregateOffer', lowPrice: '10', priceCurrency: 'USD' }]) {
      const context = createTestContext(jsonld({ '@type': 'Product', name: 'Example', image: 'https://example.com/a.jpg', offers }));
      expect((await structuredDataProductRule.run(context)).status).not.toBe('fail');
    }
  });
});

describe('rendered crawl discovery', () => {
  it('visits rendered-only links and records graph edges without replacing raw links', async () => {
    const visited: string[] = [];
    const crawler = new Crawler({ maxPages: 5, concurrency: 1, respectRobots: false,
      fetchPage: async (url) => {
        visited.push(url);
        const html = '<title>Raw page</title><div id="root"></div>';
        return { html, $: load(html), headers: {}, statusCode: 200, responseTime: 1 };
      },
      renderPage: async (url) => ({ cwv: {}, html: url.endsWith('/detail') ? '<title>Detail</title>' : '<a href="/detail">Detail</a><a href="/detail">Again</a><a href="/skip" rel="nofollow">Skip</a><a href="https://other.example/x">External</a>' }),
    });
    const pages = await crawler.crawl('https://example.com/');
    expect(visited).toEqual(['https://example.com/', 'https://example.com/detail']);
    expect(pages[0].context.links).toEqual([]);
    const site = crawler.buildSiteContext();
    expect(site.inboundLinksByUrl.get('https://example.com/detail')).toEqual(new Set(['https://example.com/']));
    expect(site.depthByUrl.get('https://example.com/detail')).toBe(1);
  });

  it('uses the same Google noindex interpretation in the site graph', async () => {
    const crawler = new Crawler({ maxPages: 1, respectRobots: false,
      fetchPage: async () => ({ html: '<meta name="googlebot" content="noindex">', $: load('<meta name="googlebot" content="noindex">'), headers: {}, statusCode: 200, responseTime: 1 }),
    });
    await crawler.crawl('https://example.com/');
    expect(crawler.buildSiteContext().pages?.get('https://example.com/')?.noindex).toBe(true);
  });
});
