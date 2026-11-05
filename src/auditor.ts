import { safeFetch, readResponseBytes, withNetworkSession, currentNetworkSession, validateNetworkUrl, isNetworkPolicyError } from './crawler/network.js';
import { sanitizeForOutput } from './sanitize.js';
import { prepareDuplicateComparisons } from './analysis/content-duplicates.js';
import { readHreflang } from './analysis/hreflang.js';
import type {
  AuditContext,
  AuditResult,
  CategoryResult,
  RuleResult,
  CategoryDefinition,
  CoreWebVitals,
  RenderDiagnostics,
  RenderQuality,
  AssetInfo,
  SiteContext,
  SitemapFetchResult,
  AuditRunOptions,
} from './types.js';
import { categories, getCategoryById } from './categories/index.js';
import { getRulesByCategory, resetCrossPageState } from './rules/registry.js';
import { isRuleEnabled } from './rules/pattern-matcher.js';
import { loadAllRules } from './rules/loader.js';
import {
  fetchPage,
  unauditableReason,
  createAuditContext,
  fetchPageWithPlaywright,
  closeBrowser,
  Crawler,
  type CrawledPage,
  type CrawlProgress,
  type PlaywrightFetchResult,
  type RenderOptions,
} from './crawler/index.js';
import { buildPageSnapshot } from './page-snapshot.js';
import { SCORING_VERSION } from './scoring.js';
import { applyScoreCaps, pageCaps, readPageFacts, siteCaps } from './score-caps.js';
import { AuditError, rethrowIfAborted, throwIfAborted } from './errors.js';
import { getUserAgent } from './crawler/user-agent.js';
import type { UrlFilterOptions } from './crawler/url-filter.js';
import { fetchSitemap } from './crawler/sitemap.js';
import {
  buildCategoryResult,
  buildAuditResult,
} from './scoring.js';

/**
 * Callback for when a category audit starts
 */
export type OnCategoryStartCallback = (categoryId: string, categoryName: string) => void;

/**
 * Callback for when a category audit completes
 */
export type OnCategoryCompleteCallback = (
  categoryId: string,
  categoryName: string,
  result: CategoryResult
) => void;

/**
 * Callback for when a rule completes
 */
export type OnRuleCompleteCallback = (
  ruleId: string,
  ruleName: string,
  result: RuleResult
) => void;

/**
 * Callback for when a page audit completes (in crawl mode)
 */
export type OnPageCompleteCallback = (
  url: string,
  pageNumber: number,
  totalPages: number
) => void;

/**
 * Callback for crawl discovery progress, before any page is scored.
 *
 * A crawl spends most of its time here, and until now the CLI showed a bar
 * that only moved once the crawl had already finished.
 */
export type OnCrawlProgressCallback = (progress: CrawlProgress) => void;

/**
 * Mark every sitemap URL as sitemap-discovered on the shared site graph.
 *
 * Lives here rather than in the crawler because the Auditor owns the sitemap
 * fetch; the crawler never sees sitemap data. Marks the source only — sitemap
 * URLs are deliberately NOT queued for crawling, which would blow up crawl
 * scope. Keys go through `site.normalize` so they line up with the crawler's
 * own map keys.
 */
export function markSitemapDiscoverySources(
  site: SiteContext,
  sitemap: SitemapFetchResult
): void {
  if (!sitemap.urls.length) return;

  const map = site.discoverySourceByUrl ?? new Map();
  site.discoverySourceByUrl = map;

  for (const url of sitemap.urls) {
    const key = site.normalize(url);
    let sources = map.get(key);
    if (!sources) {
      sources = new Set();
      map.set(key, sources);
    }
    sources.add('sitemap');
  }
}

/**
 * Options for configuring the Auditor
 */
export interface AuditorOptions {
  /** Include sitemap-only URLs in a crawl's initial frontier. */
  crawlSitemap?: boolean;
  /** Explicit permission to connect to local/intranet addresses. */
  allowPrivate?: boolean;
  /** Maximum simultaneous HTTP requests to each host. */
  perHostConcurrency?: number;
  /** Maximum simultaneous HTTP probes across hosts. */
  concurrency?: number;
  /** Categories to audit (empty array = all categories) */
  categories?: string[];
  /** Request timeout in milliseconds */
  timeout?: number;
  /** Whether to measure Core Web Vitals with Playwright */
  measureCwv?: boolean;
  /**
   * Also render the page at a mobile viewport and run mobile-first parity rules.
   * Requires measureCwv (a browser render). Roughly doubles render time, so it
   * is off by default.
   */
  mobileParity?: boolean;
  /**
   * Perform a synthetic interaction during the render so INP can be measured.
   * Requires measureCwv. The resulting INP is flagged as synthetic.
   */
  simulateInteraction?: boolean;
  /**
   * Whether a crawl obeys the site's robots.txt. Defaults to true; `staging`
   * turns it off.
   */
  respectRobots?: boolean;
  /**
   * Audit a staging site, which is kept out of search on purpose. The noindex
   * and robots.txt caps are waived and reported as `waivedCaps`, and a crawl
   * ignores robots.txt so a `Disallow: /` staging site can be crawled at all.
   * The content caps still apply. Defaults to false.
   */
  staging?: boolean;
  /**
   * Which URLs a crawl may visit and how they are normalised, from the
   * `[crawler]` include/exclude and query-parameter keys.
   */
  urlFilter?: Partial<UrlFilterOptions>;
  /**
   * Rule id patterns to run, from `rules.enable`. Empty (or `['*']`) means
   * every rule, matching the config default.
   */
  enableRules?: string[];
  /** Rule id patterns to skip, from `rules.disable`. Takes precedence. */
  disableRules?: string[];
  /** Minimum gap between requests, from `crawler.delay_ms` */
  delayMs?: number;
  /** Minimum gap between requests to one host, from `crawler.per_host_delay_ms` */
  perHostDelayMs?: number;
  /** Optional browser-based page fetcher (replaces Playwright when provided) */
  browserFetcher?: (
    url: string,
    timeout: number,
    options?: RenderOptions
  ) => Promise<PlaywrightFetchResult>;
  /** Callback when category audit starts */
  onCategoryStart?: OnCategoryStartCallback;
  /** Callback when category audit completes */
  onCategoryComplete?: OnCategoryCompleteCallback;
  /** Callback when a rule completes */
  onRuleComplete?: OnRuleCompleteCallback;
  /** Callback when a page completes (crawl mode) */
  onPageComplete?: OnPageCompleteCallback;
  /** Callback as the crawl discovers and fetches pages (crawl mode) */
  onCrawlProgress?: OnCrawlProgressCallback;
  /** Callback as each page's fetch begins (crawl mode) */
  onPageStart?: (url: string) => void;
  /**
   * Cancels the run. Every fetch, render and page loop checks it, so an
   * aborted audit stops within a request rather than running to completion in
   * the background. The call rejects with an `AuditAbortedError`.
   */
  signal?: AbortSignal;
}

/**
 * Resolved options with defaults applied.
 * browserFetcher stays optional because it has no default.
 */
type ResolvedAuditorOptions = Required<Omit<AuditorOptions, 'browserFetcher' | 'signal'>> &
  Pick<AuditorOptions, 'browserFetcher' | 'signal'>;

/**
 * Main Auditor class for running SEO audits
 */
export class Auditor {
  private options: ResolvedAuditorOptions;
  private rulesLoaded = false;
  private categoriesToAudit: CategoryDefinition[] = [];

  constructor(options: AuditorOptions = {}) {
    this.options = {
      crawlSitemap: options.crawlSitemap ?? false,
      allowPrivate: options.allowPrivate ?? false,
      perHostConcurrency: options.perHostConcurrency ?? 2,
      concurrency: options.concurrency ?? 3,
      categories: options.categories ?? [],
      timeout: options.timeout ?? 30000,
      measureCwv: options.measureCwv ?? false,
      mobileParity: options.mobileParity ?? false,
      simulateInteraction: options.simulateInteraction ?? false,
      // Defaults to true so a programmatic crawl is polite unless asked not to
      // be. A staging site's robots.txt blocks everything on purpose, and it
      // is the user's own site, so staging crawls past it.
      respectRobots: options.staging ? false : (options.respectRobots ?? true),
      staging: options.staging ?? false,
      // 0 rather than the config's 100/200: a programmatic Auditor is not
      // silently slowed down. The CLI passes the configured values.
      urlFilter: options.urlFilter ?? {},
      enableRules: options.enableRules ?? [],
      disableRules: options.disableRules ?? [],
      delayMs: options.delayMs ?? 0,
      perHostDelayMs: options.perHostDelayMs ?? 0,
      browserFetcher: options.browserFetcher,
      signal: options.signal,
      onCategoryStart: options.onCategoryStart ?? (() => {}),
      onCategoryComplete: options.onCategoryComplete ?? (() => {}),
      onRuleComplete: options.onRuleComplete ?? (() => {}),
      onPageComplete: options.onPageComplete ?? (() => {}),
      onCrawlProgress: options.onCrawlProgress ?? (() => {}),
      onPageStart: options.onPageStart ?? (() => {}),
    };

    // Determine which categories to audit
    this.categoriesToAudit = this.filterCategories();
  }

  /**
   * Filter categories based on options
   */
  private filterCategories(): CategoryDefinition[] {
    if (this.options.categories.length === 0) {
      // Audit all categories
      return categories;
    }

    // Filter to only specified categories
    return categories.filter((cat) =>
      this.options.categories.includes(cat.id)
    );
  }

  /**
   * Ensure rules are loaded before running audit
   */
  private async ensureRulesLoaded(): Promise<void> {
    if (!this.rulesLoaded) {
      await loadAllRules();
      this.rulesLoaded = true;
    }
  }

  /**
   * Fetch robots.txt content for a site
   */
  private async fetchRobotsTxt(url: string): Promise<string | undefined> {
    const signal = this.options.signal;
    throwIfAborted(signal);
    try {
      const urlObj = new URL(url);
      const robotsUrl = `${urlObj.protocol}//${urlObj.host}/robots.txt`;
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 5000);
      try {
        const response = await safeFetch(robotsUrl, {
          signal: signal ? AbortSignal.any([signal, controller.signal]) : controller.signal,
          headers: {
            'User-Agent': getUserAgent(),
          },
        });
        clearTimeout(timeoutId);
        if (response.ok) {
          return new TextDecoder().decode(await readResponseBytes(response, 1024 * 1024));
        }
      } finally {
        clearTimeout(timeoutId);
      }
    } catch (error) {
      // Robots.txt fetch failed, continue without it
      rethrowIfAborted(error, signal);
    }
    return undefined;
  }

  /**
   * Discover and fetch the site's sitemap(s).
   *
   * Delegates to the sitemap module, which follows sitemap indexes,
   * decompresses gzipped sitemaps and reads every `Sitemap:` line in
   * robots.txt rather than only the first.
   */
  private async fetchSitemap(
    url: string,
    robotsTxtContent?: string
  ): Promise<SitemapFetchResult> {
    return fetchSitemap(url, robotsTxtContent, this.options.signal);
  }

  /**
   * Enrich audit context with robots.txt, sitemap data
   */
  private async enrichContext(context: AuditContext, url: string): Promise<void> {
    // Fetch robots.txt first (needed for sitemap URL discovery)
    const robotsTxtContent = await this.fetchRobotsTxt(url);
    context.robotsTxtContent = robotsTxtContent;

    // Fetch sitemap using robots.txt info
    const sitemapData = await this.fetchSitemap(url, robotsTxtContent);
    this.applySitemapData(context, sitemapData);
  }

  /**
   * Copy shared sitemap data onto a page context
   */
  private applySitemapData(context: AuditContext, sitemap: SitemapFetchResult): void {
    context.sitemapContent = sitemap.content;
    context.sitemapUrls = sitemap.urls;
    context.sitemapUrlSources = sitemap.urlSources;
    context.sitemapEntries = sitemap.entries;
    context.sitemapIsIndex = sitemap.isIndex;
    context.sitemapDocuments = sitemap.documents;
    context.sitemapSkippedCount = sitemap.skippedSitemaps;
    context.sitemapTruncated = sitemap.truncated;
  }

  /**
   * Run a single-page audit
   * @param url - URL to audit
   * @returns AuditResult for the page
   */
  async audit(url: string): Promise<AuditResult> {
    return withNetworkSession(this.options, async () => sanitizeForOutput(await this.auditPage(url)));
  }

  private async auditPage(url: string): Promise<AuditResult> {
    validateNetworkUrl(url, this.options.allowPrivate);
    throwIfAborted(this.options.signal);
    await this.ensureRulesLoaded();
    resetCrossPageState();

    // Fetch the page, recording the redirect hops so redirect-loop and
    // redirect-broken have a chain to read.
    const fetchResult = await fetchPage(url, this.options.timeout, {
      trackRedirects: true,
      ...(this.options.signal && { signal: this.options.signal }),
    });

    // Refuse to score something that is not an auditable page. Most rules pass
    // when the thing they check is absent, so an empty body used to score
    // 84/100 and a JSON response 83 — confidently wrong is worse than an error.
    const unauditable = unauditableReason(
      url,
      fetchResult.headers['content-type'] ?? null,
      fetchResult.html
    );
    if (unauditable) {
      throw new AuditError('non-html', unauditable);
    }

    // Same reasoning one step earlier: a 404 is not a page to score. It was
    // fetched, parsed and audited like any other document, so a typo'd URL came
    // back with a confident 87/100 for a page that does not exist — and most
    // rules pass when the thing they check is absent, so the score reads
    // healthy rather than obviously wrong.
    //
    // Reported with the final URL after redirects, because a 301 to a 404 is
    // the case where the address the user typed is not the address that failed.
    if (fetchResult.statusCode >= 400) {
      const chain = fetchResult.redirectChain;
      const finalUrl = chain && chain.length > 0 ? chain[chain.length - 1].url : url;
      const via = finalUrl !== url ? ` (redirected to ${finalUrl})` : '';
      throw new AuditError(
        'http-error',
        `The page returned HTTP ${fetchResult.statusCode}${via}.`
      );
    }

    // Get Core Web Vitals and rendered DOM if enabled
    let cwv: CoreWebVitals = {};
    let renderUnavailableReason: string | undefined;
    let httpProtocol: string | undefined;
    let renderedHtml: string | undefined;
    let renderQuality: RenderQuality | undefined;
    let rendered$: import('cheerio').CheerioAPI | undefined;
    let renderDiagnostics: RenderDiagnostics | undefined;
    let assets: AssetInfo[] | undefined;
    let mobileHtml: string | undefined;
    let mobile$: import('cheerio').CheerioAPI | undefined;
    if (this.options.measureCwv) {
      const fetcher = this.options.browserFetcher ?? fetchPageWithPlaywright;
      try {
        const pwResult = await fetcher(new URL(url).username || new URL(url).password ? url : (fetchResult.finalUrl ?? url), this.options.timeout, {
          simulateInteraction: this.options.simulateInteraction,
          allowPrivate: this.options.allowPrivate,
          ...(this.options.signal && { signal: this.options.signal }),
        });
        cwv = pwResult.cwv;
        renderQuality = pwResult.renderQuality;
        if (renderQuality?.state === 'incomplete') renderUnavailableReason = renderQuality.reason;
        httpProtocol = pwResult.httpProtocol;
        renderDiagnostics = pwResult.diagnostics;
        assets = pwResult.assets;
        // Capture rendered HTML for JS rendering rules
        if (pwResult.html) {
          renderedHtml = pwResult.html;
          const cheerio = await import('cheerio');
          rendered$ = cheerio.load(renderedHtml);
        }

        // Compare mobile and desktop while the shared browser is still open.
        if (this.options.mobileParity) {
          try {
            const mobileResult = await fetcher(url, this.options.timeout, {
              mobile: true,
              allowPrivate: this.options.allowPrivate,
              ...(this.options.signal && { signal: this.options.signal }),
            });
            if (mobileResult.html && mobileResult.renderQuality?.state !== 'incomplete') {
              mobileHtml = mobileResult.html;
              const cheerio = await import('cheerio');
              mobile$ = cheerio.load(mobileHtml);
            }
          } catch (error) {
            rethrowIfAborted(error, this.options.signal);
            // Mobile render failed; parity rules report unmeasured
          }
        }
      } catch (error) {
        rethrowIfAborted(error, this.options.signal);
        renderUnavailableReason = error instanceof Error ? error.message : 'Browser render unavailable';
        // CWV measurement failed, continue without it
      } finally {
        // Clean up Playwright browser (only when not using an injected fetcher)
        if (!this.options.browserFetcher) {
          await closeBrowser();
        }
      }
    }

    // Create audit context
    const context = createAuditContext(url, fetchResult, cwv);
    context.httpProtocol = httpProtocol;
    context.renderUnavailableReason = renderUnavailableReason;
    context.renderQuality = renderQuality;
    if (this.options.signal) {
      context.signal = this.options.signal;
    }

    // Enrich with robots.txt, sitemap, and rendered DOM
    await this.enrichContext(context, context.url);
    if (renderedHtml) {
      context.renderedHtml = renderedHtml;
      context.rendered$ = renderQuality?.state === 'incomplete' ? undefined : rendered$;
    }
    if (renderDiagnostics) {
      context.renderDiagnostics = renderDiagnostics;
    }
    if (assets) {
      context.assets = assets;
    }
    if (mobileHtml) {
      context.mobileHtml = mobileHtml;
      context.mobile$ = mobile$;
    }

    // Run all categories
    const categoryResults = await this.runAllCategories(context);

    // Build the final result, then hold the score down for any condition the
    // category average cannot express (see score-caps.ts)
    const timestamp = new Date().toISOString();
    const result = buildAuditResult(
      url,
      categoryResults,
      this.categoriesToAudit,
      timestamp,
      1,
      buildPageSnapshot(context),
      this.runOptions(false, 1, 1),
      { pages: [context.url], detail: 'per-page', ...(renderQuality && { rendering: [{ url: context.url, ...renderQuality }] }), ...(renderUnavailableReason && { unavailableMeasurements: [renderUnavailableReason] }) }
    );
    return applyScoreCaps(result, pageCaps(readPageFacts(context), { staging: this.options.staging }));
  }

  /**
   * Run audit with crawling (multiple pages)
   * @param url - Starting URL to crawl from
   * @param maxPages - Maximum number of pages to crawl
   * @param concurrency - Number of concurrent requests
   * @returns AuditResult with aggregated scores
   */
  async auditWithCrawl(
    url: string,
    maxPages = 10,
    concurrency = 3
  ): Promise<AuditResult> {
    return withNetworkSession({ ...this.options, concurrency }, async () =>
      sanitizeForOutput(await this.auditCrawl(url, maxPages, concurrency)));
  }

  private async auditCrawl(url: string, maxPages: number, concurrency: number): Promise<AuditResult> {
    validateNetworkUrl(url, this.options.allowPrivate);
    throwIfAborted(this.options.signal);
    await this.ensureRulesLoaded();
    resetCrossPageState();

    // Pre-fetch robots.txt and sitemap once for the entire crawl
    const robotsTxtContent = await this.fetchRobotsTxt(url);
    const sitemapData = await this.fetchSitemap(url, robotsTxtContent);

    // Create crawler with browser rendering if enabled
    const fetcher = this.options.browserFetcher ?? fetchPageWithPlaywright;
    const crawler = new Crawler({
      seedUrls: this.options.crawlSitemap ? sitemapData.urls : undefined,
      robotsTxtContent,
      allowPrivate: this.options.allowPrivate,
      perHostConcurrency: this.options.perHostConcurrency,
      maxPages,
      concurrency,
      timeout: this.options.timeout,
      respectRobots: this.options.respectRobots,
      urlFilter: this.options.urlFilter,
      delayMs: this.options.delayMs,
      perHostDelayMs: this.options.perHostDelayMs,
      ...(this.options.signal && { signal: this.options.signal }),
      onProgress: (progress) => this.options.onCrawlProgress(progress),
      onPageStart: (pageUrl) => this.options.onPageStart(pageUrl),
      renderPage: this.options.measureCwv
        ? async (pageUrl: string) => {
            try {
              const result = await fetcher(pageUrl, this.options.timeout, {
                allowPrivate: this.options.allowPrivate,
                simulateInteraction: this.options.simulateInteraction,
                ...(this.options.signal && { signal: this.options.signal }),
              });
              // `html` is what the JS-rendering rules read. Leaving it out here
              // is what made all eleven of them report "rendered DOM not
              // available" on every page of every crawl.
              let mobileHtml: string | undefined;
              let mobileUnavailableReason: string | undefined;
              if (this.options.mobileParity) {
                try {
                  const mobileResult = await fetcher(pageUrl, this.options.timeout, {
                    mobile: true, allowPrivate: this.options.allowPrivate,
                    ...(this.options.signal && { signal: this.options.signal }),
                  });
                  if (mobileResult.renderQuality?.state === 'incomplete') mobileUnavailableReason = mobileResult.renderQuality.reason;
                  else mobileHtml = mobileResult.html;
                } catch (error) {
                  rethrowIfAborted(error, this.options.signal);
                  mobileUnavailableReason = error instanceof Error ? error.message : 'Mobile rendering failed';
                }
              }
              return {
                mobileHtml, mobileUnavailableReason,
                cwv: result.cwv,
                renderQuality: result.renderQuality,
                httpProtocol: result.httpProtocol,
                html: result.html,
                diagnostics: result.diagnostics,
                assets: result.assets,
              };
            } catch (error) {
              rethrowIfAborted(error, this.options.signal);
              return { cwv: {}, unavailableReason: error instanceof Error ? error.message : 'Browser render unavailable' };
            }
          }
        : undefined,
    });

    // Crawl the site. The browser is closed whatever happens, including a
    // cancellation: a leaked Chromium outlives the process that started it.
    let crawledPages: CrawledPage[];
    try {
      crawledPages = await crawler.crawl(url, maxPages, concurrency);
    } finally {
      if (this.options.measureCwv && !this.options.browserFetcher) {
        await closeBrowser();
      }
    }

    if (crawledPages.length === 0) {
      throw new AuditError('no-pages', `The crawl of ${url} found no pages to audit`);
    }

    // Build the site graph once, then share it by reference with every page so
    // rules can answer cross-page questions (inbound links, click depth).
    const site = crawler.buildSiteContext();
    markSitemapDiscoverySources(site, sitemapData);

    // Enrich each crawled page context with shared data
    for (const crawledPage of crawledPages) {
      if (crawledPage.context) {
        crawledPage.context.robotsTxtContent = robotsTxtContent;
        crawledPage.context.site = site;
        if (this.options.signal) {
          crawledPage.context.signal = this.options.signal;
        }
        this.applySitemapData(crawledPage.context, sitemapData);
        const info = site.pages?.get(site.normalize(crawledPage.context.url));
        if (info) for (const tag of readHreflang(crawledPage.context)) {
          try { info.hreflangOut[tag.hreflang.toLowerCase()] = new URL(tag.href, crawledPage.context.documentBaseUrl ?? crawledPage.context.url).href; } catch { /* Invalid target is reported by the declaration rule. */ }
        }
      }
    }

    // Aggregate results from all pages
    const allCategoryResults = await this.auditPages(crawledPages);

    // Build the final result, then cap it if search engines cannot index the
    // start page. A site-wide block always reaches it; averaged with the
    // pages behind it, it moved the score by a point (see score-caps.ts).
    const timestamp = new Date().toISOString();
    const result = buildAuditResult(
      url,
      allCategoryResults,
      this.categoriesToAudit,
      timestamp,
      crawledPages.filter((page) => !page.error).length,
      undefined,
      this.runOptions(true, maxPages, concurrency),
      { pages: crawledPages.filter((p) => !p.error).map((p) => p.context.url), detail: 'per-page', crawl: site.coverage,
        rendering: crawledPages.flatMap((p) => p.context.renderQuality ? [{ url: p.context.url, ...p.context.renderQuality }] : []),
        unavailableMeasurements: crawledPages.flatMap((p) => p.context.renderUnavailableReason ? [`${p.context.url}: ${p.context.renderUnavailableReason}`] : []) }
    );
    const start = crawledPages.find((page) => site.normalize(page.url) === site.entryUrl && !page.error);
    if (!start) return result;
    return applyScoreCaps(
      result,
      siteCaps(readPageFacts(start.context), start.url, { staging: this.options.staging })
    );
  }

  /**
   * Run every category across multiple pages and aggregate the rule results.
   *
   * Each category's score is the weighted average over every rule result from
   * every page, so a rule that fails on 3 of 50 pages drags the category down
   * proportionally rather than deciding it outright.
   *
   * Used by both the live crawl path and `seomator analyze`, which replays
   * pages from a stored crawl.
   *
   * @param pages - Pages to audit; entries with an `error` are skipped
   * @returns One CategoryResult per audited category
   */
  async auditPages(pages: CrawledPage[]): Promise<CategoryResult[]> {
    if (!currentNetworkSession()) return withNetworkSession(this.options, () => this.auditPages(pages));
    const crawledPages = pages;
    if (this.categoriesToAudit.some((category) => category.id === 'content') &&
      ['content-duplicate-exact', 'content-duplicate-near'].some((id) => isRuleEnabled(id, this.options.enableRules, this.options.disableRules))) {
      prepareDuplicateComparisons(pages.filter((page) => !page.error).map((page) => page.context));
    }
    // Collect all rule results per category across all pages
    const categoryRuleResults = new Map<string, RuleResult[]>();

    // Initialize map for each category
    for (const category of this.categoriesToAudit) {
      categoryRuleResults.set(category.id, []);
    }

    let pageNumber = 0;
    for (const crawledPage of crawledPages) {
      throwIfAborted(this.options.signal);
      pageNumber++;

      // Skip pages with errors
      if (crawledPage.error) {
        this.options.onPageComplete(crawledPage.url, pageNumber, crawledPages.length);
        continue;
      }

      // Run categories for this page
      const pageResults = await this.runAllCategories(crawledPage.context);

      // Merge results into aggregated map
      for (const categoryResult of pageResults) {
        const existing = categoryRuleResults.get(categoryResult.categoryId);
        if (existing) {
          existing.push(...categoryResult.results);
        }
      }

      this.options.onPageComplete(crawledPage.url, pageNumber, crawledPages.length);
    }

    // Build final category results from aggregated data
    const finalResults: CategoryResult[] = [];
    for (const category of this.categoriesToAudit) {
      const results = categoryRuleResults.get(category.id) ?? [];
      finalResults.push(buildCategoryResult(category.id, results));
    }

    return finalResults;
  }

  /**
   * Run all categories against an audit context
   * @param context - The audit context to run rules against
   * @returns Array of CategoryResult
   */
  async runAllCategories(context: AuditContext): Promise<CategoryResult[]> {
    if (!currentNetworkSession()) return withNetworkSession(this.options, () => this.runAllCategories(context));
    const results: CategoryResult[] = [];

    for (const category of this.categoriesToAudit) {
      throwIfAborted(this.options.signal);

      // Notify start
      this.options.onCategoryStart(category.id, category.name);

      // Get rules for this category, minus anything `rules.enable` /
      // `rules.disable` excludes.
      const rules = getRulesByCategory(category.id).filter((rule) =>
        isRuleEnabled(rule.id, this.options.enableRules, this.options.disableRules)
      );

      // A category with every rule filtered out is not a category that scored
      // zero. calculateCategoryScore([]) returns 0, so keeping it would drag
      // the overall score down and report a narrower audit as a catastrophic
      // one. Dropping it lets calculateOverallScore renormalise over the
      // categories that actually ran.
      if (rules.length === 0) {
        continue;
      }

      const ruleResults: RuleResult[] = [];

      // Run each rule
      for (const rule of rules) {
        try {
          const result = await rule.run(context);
          // Inject ruleId, weight and page URL for consistent tracking.
          // A result that set its own weight keeps it — that is how
          // notMeasured() opts a result out of scoring with weight 0.
          const resultWithMeta: RuleResult = sanitizeForOutput({
            ...result,
            ruleId: rule.id,
            weight: result.weight ?? rule.weight,
            details: {
              ...result.details,
              pageUrl: context.url,
            },
          });
          ruleResults.push(resultWithMeta);
          this.options.onRuleComplete(rule.id, rule.name, resultWithMeta);
        } catch (error) {
          // A cancelled run is not a rule failure: stop rather than scoring
          // 332 rules as "execution failed".
          rethrowIfAborted(error, this.options.signal);

          // Rule threw an error, treat as fail
          const errorResult: RuleResult = sanitizeForOutput({
            ruleId: rule.id,
            status: isNetworkPolicyError(error) ? 'not-measured' : 'fail',
            message: `Rule execution failed: ${error instanceof Error ? error.message : 'Unknown error'}`,
            score: isNetworkPolicyError(error) ? 50 : 0,
            weight: isNetworkPolicyError(error) ? 0 : rule.weight,
            details: {
              pageUrl: context.url,
            },
          });
          ruleResults.push(errorResult);
          this.options.onRuleComplete(rule.id, rule.name, errorResult);
        }
      }

      // Build category result
      const categoryResult = buildCategoryResult(category.id, ruleResults);
      results.push(categoryResult);

      // Notify complete
      this.options.onCategoryComplete(category.id, category.name, categoryResult);
    }

    return results;
  }

  /**
   * The options this audit ran with, recorded on the result.
   *
   * Two scores are only comparable if they were measured the same way, and
   * the CLI and the desktop app do not default the same: `--no-cwv` is
   * opt-out, while the GUI's Core Web Vitals toggle is off. Both write to the
   * same history.
   */
  private runOptions(crawl: boolean, maxPages: number, concurrency: number): AuditRunOptions {
    return {
      crawl,
      crawlSitemap: this.options.crawlSitemap,
      maxPages,
      concurrency,
      measureCwv: this.options.measureCwv,
      mobile: this.options.mobileParity,
      simulateInteraction: this.options.simulateInteraction,
      categories: this.options.categories,
      scoringVersion: SCORING_VERSION,
      allowPrivate: this.options.allowPrivate,
      enableRules: this.options.enableRules,
      disableRules: this.options.disableRules,
      // Recorded only when set: absent reads as a production audit, which is
      // what every audit stored before the option existed was.
      ...(this.options.staging && { staging: true }),
      timeout: this.options.timeout,
    };
  }

  /**
   * Get the categories that will be audited
   */
  getCategoriesToAudit(): CategoryDefinition[] {
    return this.categoriesToAudit;
  }
}

/**
 * Create an Auditor instance with options
 * @param options - Auditor configuration options
 * @returns Configured Auditor instance
 */
export function createAuditor(options?: AuditorOptions): Auditor {
  return new Auditor(options);
}
