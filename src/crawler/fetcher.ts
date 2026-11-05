import { safeFetch, memoizeProbe, readResponseBytes, currentNetworkSession } from './network.js';
import * as cheerio from 'cheerio';
import { getUserAgent } from './user-agent.js';
import { AuditError, rethrowIfAborted, throwIfAborted } from '../errors.js';
import { parseSetCookieHeaders } from './cookies.js';
import type { CheerioAPI } from 'cheerio';
import type {
  AuditContext,
  LinkInfo,
  ImageInfo,
  CoreWebVitals,
  InvalidLinkInfo,
  SpecialLinkInfo,
  FigureInfo,
  InlineSvgInfo,
  PictureElementInfo,
  CookieInfo,
  RedirectChainEntry,
} from '../types.js';

/**
 * Result of fetching a page
 */
export interface FetchResult {
  /** Requested address and final document address after redirects. */
  requestedUrl?: string;
  finalUrl?: string;
  tls?: { validTo?: string; protocol?: string };
  /** Raw HTML content */
  html: string;
  /** Cheerio instance for DOM querying */
  $: CheerioAPI;
  /** HTTP response headers */
  headers: Record<string, string>;
  /** HTTP status code */
  statusCode: number;
  /** Response time in milliseconds */
  responseTime: number;
  /**
   * Cookies set by the server on this response.
   *
   * Optional because not every FetchResult comes from a live fetch: pages
   * replayed from a stored crawl have no recoverable Set-Cookie headers, and
   * an empty array there would read as "this page sets no cookies" rather
   * than "we do not know".
   */
  cookies?: CookieInfo[];
  /**
   * Every hop taken to reach this page, in order, when the caller asked for
   * redirect tracking.
   *
   * Optional because tracking costs an extra manual follow loop and only the
   * page-audit path needs it: the rules that fetch robots.txt and sitemaps
   * through this function do not. Absent means "not recorded", which is what
   * `redirect-loop` and `redirect-broken` report as unmeasured — distinct from
   * an empty chain, which would claim the page was reached directly.
   */
  redirectChain?: RedirectChainEntry[];
}

/**
 * Fetch a page with HTTP GET and parse with Cheerio
 * @param url - URL to fetch
 * @param timeout - Request timeout in milliseconds (default: 30000)
 * @returns FetchResult with html, $, headers, statusCode, responseTime
 */
/** Content types that can meaningfully be audited as a web page. */
const AUDITABLE_CONTENT_TYPES = ['text/html', 'application/xhtml+xml'];

/**
 * Reject responses that are not an auditable HTML page.
 *
 * Nothing used to check this, so a zero-byte body or a JSON response was parsed
 * as HTML and scored like any other page — an empty response scored 84/100,
 * because most rules pass when the thing they check is simply absent. A score
 * is worse than an error there: it is confidently wrong.
 *
 * Callers that audit a page apply this; fetchPage itself does not, because it
 * is also how rules retrieve robots.txt and other non-HTML resources.
 *
 * @param url - The URL that was fetched, for the message
 * @param contentType - Raw Content-Type header, if the server sent one
 * @param html - The response body
 * @returns Why the response cannot be audited, or null when it can
 */
export function unauditableReason(
  url: string,
  contentType: string | null,
  html: string
): string | null {
  if (html.trim().length === 0) {
    return `${url} returned an empty response body, so there is nothing to audit`;
  }

  const type = (contentType ?? '').split(';')[0]!.trim().toLowerCase();

  if (type && !AUDITABLE_CONTENT_TYPES.includes(type)) {
    return `${url} returned ${type}, which is not an HTML page`;
  }

  // Some servers omit Content-Type entirely; fall back to looking for markup
  // rather than rejecting a page that is genuinely HTML.
  if (!type && !/<\s*(!doctype|html|head|body)\b/i.test(html)) {
    return `${url} returned no Content-Type and no HTML markup`;
  }

  return null;
}

/** Hop limit when following redirects by hand, matching browser behaviour. */
const MAX_TRACKED_REDIRECTS = 20;

/** Request headers shared by both fetch paths. */
function pageRequestHeaders(): Record<string, string> {
  return {
    'User-Agent': getUserAgent(),
    'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
    'Accept-Language': 'en-US,en;q=0.5',
  };
}

/**
 * Options for {@link fetchPage}
 */
export interface FetchPageOptions {
  /**
   * Record every hop taken to reach the page.
   *
   * Off by default: it costs a manual follow loop, and only the page-audit
   * path needs the chain. `redirect: 'follow'` discards it, which is why
   * `redirect-loop` and `redirect-broken` had nothing to read.
   */
  trackRedirects?: boolean;
  /** Cancels the request; the run's signal, combined with the timeout */
  signal?: AbortSignal;
}

/**
 * A request signal that fires on the caller's cancellation or the timeout,
 * whichever comes first. The timer is cleared by `dispose()`.
 */
export function requestSignal(
  timeout: number,
  signal?: AbortSignal
): { signal: AbortSignal; timedOut: () => boolean; dispose: () => void } {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeout);
  return {
    signal: signal ? AbortSignal.any([signal, controller.signal]) : controller.signal,
    timedOut: () => controller.signal.aborted,
    dispose: () => clearTimeout(timeoutId),
  };
}

/**
 * Walk a redirect chain by hand, returning the first non-redirect response.
 *
 * Stops early on a URL already seen so the chain still carries the repeat for
 * `redirect-loop` to find, rather than spending the full hop budget on it.
 */
async function fetchFollowingRedirects(
  url: string,
  signal: AbortSignal
): Promise<{ response: Response; chain: RedirectChainEntry[] }> {
  const chain: RedirectChainEntry[] = [];
  const seen = new Set<string>();
  let currentUrl = url;
  const headers = new Headers(pageRequestHeaders());
  const credentials = new URL(url);
  if (credentials.username || credentials.password) headers.set('authorization', `Basic ${Buffer.from(`${decodeURIComponent(credentials.username)}:${decodeURIComponent(credentials.password)}`).toString('base64')}`);

  for (let hop = 0; hop <= MAX_TRACKED_REDIRECTS; hop++) {
    const response = await safeFetch(currentUrl, {
      method: 'GET',
      signal,
      headers: Object.fromEntries(headers),
      redirect: 'manual',
    });

    chain.push({ url: currentUrl, statusCode: response.status });

    const location =
      response.status >= 300 && response.status < 400
        ? response.headers.get('location')
        : null;
    if (!location) return { response, chain };

    await response.body?.cancel();
    const nextUrl = new URL(location, currentUrl).href;
    if (new URL(nextUrl).origin !== new URL(currentUrl).origin) headers.delete('authorization');
    if (seen.has(nextUrl)) {
      // A looping URL has no page to audit, and the 3xx body it would hand
      // back reads as "empty response" — which hides the actual cause. Name
      // the loop instead, listing the cycle.
      const cycle = [...chain.map((hop) => hop.url), nextUrl];
      throw new Error(`${url} redirects in a loop: ${cycle.join(' -> ')}`);
    }
    seen.add(currentUrl);
    currentUrl = nextUrl;
  }

  throw new Error(`${url} exceeded ${MAX_TRACKED_REDIRECTS} redirects`);
}

export async function fetchPage(
  url: string,
  timeout = 30000,
  options: FetchPageOptions = {}
): Promise<FetchResult> {
  throwIfAborted(options.signal);
  const request = requestSignal(timeout, options.signal);

  const startTime = performance.now();

  try {
    let response: Response;
    let redirectChain: RedirectChainEntry[] | undefined;

    if (options.trackRedirects) {
      const tracked = await fetchFollowingRedirects(url, request.signal);
      response = tracked.response;
      redirectChain = tracked.chain;
    } else {
      response = await safeFetch(url, {
        method: 'GET',
        signal: request.signal,
        headers: pageRequestHeaders(),
        redirect: 'follow',
      });
    }

    const responseTime = performance.now() - startTime;
    const html = new TextDecoder().decode(await readResponseBytes(response));

    const $ = cheerio.load(html);

    // Convert headers to plain object
    const headers: Record<string, string> = {};
    response.headers.forEach((value, key) => {
      headers[key.toLowerCase()] = value;
    });

    const finalUrl = redirectChain?.at(-1)?.url ?? (response.url || url);
    const network = currentNetworkSession();
    if (network && network.pages.size < 10_000) {
      const chain = redirectChain?.map((hop) => hop.url) ?? (url === finalUrl ? [url] : [url, finalUrl]);
      const requestedKey = new URL(url); requestedKey.hash = '';
      network.pages.set(requestedKey.href, { finalUrl, statusCode: response.status, redirectCount: chain.length - 1, chain });
      network.pages.set(finalUrl, { finalUrl, statusCode: response.status, redirectCount: 0, chain: [finalUrl] });
    }

    return {
      html,
      $,
      requestedUrl: url,
      finalUrl,
      headers,
      statusCode: response.status,
      responseTime: Math.round(responseTime),
      tls: currentNetworkSession()?.tls.get(new URL(response.url || url).origin),
      cookies: parseSetCookieHeaders(response.headers),
      ...(redirectChain && { redirectChain }),
    };
  } catch (error) {
    // A cancelled run and a slow server both surface as AbortError; tell them
    // apart here so callers never mistake a cancellation for a timeout.
    rethrowIfAborted(error, options.signal);
    if (request.timedOut()) {
      throw new AuditError('timeout', `${url} did not respond within ${timeout} ms`, { cause: error });
    }
    throw error;
  } finally {
    request.dispose();
  }
}

/**
 * Fetch a URL's status for link checking: HEAD first, confirmed with GET when
 * HEAD fails.
 *
 * Some servers answer HEAD with an error that GET does not get (bsky.app
 * returns 404, others 405 or 501) or drop it, and a single check that times
 * out is often transient. Callers report this status as the one a visitor
 * would get, so a failure is only returned once GET agrees.
 *
 * @param url - URL to check
 * @param timeout - Request timeout in milliseconds per attempt (default: 10000)
 * @param signal - The run's cancellation signal; a cancelled check throws
 * @returns HTTP status code, or 0 for a timeout or network error
 */
export async function fetchUrl(url: string, timeout = 10000, signal?: AbortSignal): Promise<number> {
  return (await fetchUrlWithRedirects(url, timeout, 20, signal)).statusCode;
}

/**
 * Result of link extraction including invalid links
 */
interface LinkExtractionResult {
  links: LinkInfo[];
  invalidLinks: InvalidLinkInfo[];
}

/**
 * Extract links from parsed HTML
 * @param $ - Cheerio instance
 * @param baseUrl - Base URL for resolving relative links
 * @returns Object with valid links and invalid links
 */
export function extractLinks($: CheerioAPI, baseUrl: string, documentUrl = baseUrl): LinkExtractionResult {
  const links: LinkInfo[] = [];
  const invalidLinks: InvalidLinkInfo[] = [];
  const baseUrlObj = new URL(documentUrl);

  $('a[href]').each((_, element) => {
    const $el = $(element);
    const href = $el.attr('href');
    const text = ($el.text().trim() || $el.attr('title') || '').slice(0, 200);

    // Check for empty or hash-only href
    if (!href || href === '' || href === '#') {
      invalidLinks.push({
        href: href || '',
        reason: 'empty',
        text,
      });
      return;
    }

    // Check for javascript: URLs
    if (/^javascript:/i.test(href)) {
      invalidLinks.push({
        href,
        reason: 'javascript',
        text,
      });
      return;
    }

    // Skip mailto:, tel:, and data: URLs (handled separately)
    if (/^(mailto:|tel:|data:)/i.test(href)) {
      return;
    }

    try {
      // Resolve relative URLs
      const resolvedUrl = new URL(href, baseUrl);
      const normalizedHref = resolvedUrl.href;

      // Determine if internal
      const isInternal = resolvedUrl.hostname === baseUrlObj.hostname;

      // Check for nofollow
      const rel = $el.attr('rel') || '';
      const isNoFollow = rel.toLowerCase().includes('nofollow');

      const inChrome =
        $el.closest('nav, header, footer, [role="navigation"], [role="banner"], [role="contentinfo"]').length > 0;

      links.push({
        href: normalizedHref,
        text,
        isInternal,
        isNoFollow,
        inChrome,
      });
    } catch {
      // Malformed URL
      invalidLinks.push({
        href,
        reason: 'malformed',
        text,
      });
    }
  });

  return { links, invalidLinks };
}

/**
 * Validate email format (basic validation)
 */
function isValidEmail(email: string): { isValid: boolean; issue?: string } {
  if (!email) {
    return { isValid: false, issue: 'Empty email address' };
  }
  // Basic email regex - checks for format: something@something.something
  const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  if (!emailRegex.test(email)) {
    return { isValid: false, issue: 'Invalid email format' };
  }
  return { isValid: true };
}

/**
 * Validate phone number format (E.164-ish: digits, spaces, dashes, parens, plus)
 */
function isValidPhone(phone: string): { isValid: boolean; issue?: string } {
  if (!phone) {
    return { isValid: false, issue: 'Empty phone number' };
  }
  // Remove allowed characters and check if remaining are digits
  const cleaned = phone.replace(/[\s\-\(\)\+\.]/g, '');
  if (!/^\d{7,15}$/.test(cleaned)) {
    return { isValid: false, issue: 'Invalid phone format (should be 7-15 digits)' };
  }
  return { isValid: true };
}

/**
 * Extract special protocol links (tel:, mailto:) from parsed HTML
 * @param $ - Cheerio instance
 * @returns Array of SpecialLinkInfo objects
 */
function extractSpecialLinks($: CheerioAPI): SpecialLinkInfo[] {
  const specialLinks: SpecialLinkInfo[] = [];

  $('a[href]').each((_, element) => {
    const $el = $(element);
    const href = $el.attr('href');
    if (!href) return;

    const text = ($el.text().trim() || $el.attr('title') || '').slice(0, 200);

    // Check for tel: links
    if (/^tel:/i.test(href)) {
      const value = href.replace(/^tel:/i, '');
      const validation = isValidPhone(value);
      specialLinks.push({
        type: 'tel',
        href,
        value,
        text,
        isValid: validation.isValid,
        ...(validation.issue && { issue: validation.issue }),
      });
      return;
    }

    // Check for mailto: links
    if (/^mailto:/i.test(href)) {
      // Extract email (before any ? for subject/body params)
      const value = href.replace(/^mailto:/i, '').split('?')[0];
      const validation = isValidEmail(value);
      specialLinks.push({
        type: 'mailto',
        href,
        value,
        text,
        isValid: validation.isValid,
        ...(validation.issue && { issue: validation.issue }),
      });
    }
  });

  return specialLinks;
}

/**
 * Extract images from parsed HTML
 * @param $ - Cheerio instance
 * @param baseUrl - Base URL for resolving relative image sources
 * @returns Array of ImageInfo objects
 */
function extractImages($: CheerioAPI, baseUrl: string): ImageInfo[] {
  const images: ImageInfo[] = [];

  $('img').each((_, element) => {
    const $el = $(element);
    const src = $el.attr('src') || $el.attr('data-src') || '';

    // Skip data URLs and empty sources
    if (!src || src.startsWith('data:')) {
      return;
    }

    let resolvedSrc = src;
    try {
      resolvedSrc = new URL(src, baseUrl).href;
    } catch {
      // Keep original if resolution fails
    }

    const alt = $el.attr('alt');
    const loading = $el.attr('loading');

    images.push({
      src: resolvedSrc,
      alt: alt ?? '',
      hasAlt: alt !== undefined,
      width: $el.attr('width'),
      height: $el.attr('height'),
      isLazyLoaded: loading === 'lazy' || $el.attr('data-src') !== undefined,
    });
  });

  return images;
}

/**
 * Extract figure elements from parsed HTML
 * @param $ - Cheerio instance
 * @returns Array of FigureInfo objects
 */
function extractFigures($: CheerioAPI): FigureInfo[] {
  const figures: FigureInfo[] = [];

  $('figure').each((_, element) => {
    const $el = $(element);
    const $figcaption = $el.find('figcaption');

    figures.push({
      hasFigcaption: $figcaption.length > 0,
      imageCount: $el.find('img').length,
      captionText: $figcaption.text().trim().slice(0, 200) || undefined,
    });
  });

  return figures;
}

/**
 * Extract inline SVG elements from parsed HTML
 * @param $ - Cheerio instance
 * @returns Array of InlineSvgInfo objects
 */
function extractInlineSvgs($: CheerioAPI): InlineSvgInfo[] {
  const svgs: InlineSvgInfo[] = [];

  $('svg').each((_, element) => {
    const $el = $(element);
    const html = $.html($el);

    svgs.push({
      sizeBytes: Buffer.byteLength(html, 'utf8'),
      hasViewBox: $el.attr('viewBox') !== undefined,
      hasTitle: $el.find('title').length > 0,
      snippet: html.slice(0, 100),
    });
  });

  return svgs;
}

/**
 * Extract picture elements from parsed HTML
 * @param $ - Cheerio instance
 * @returns Array of PictureElementInfo objects
 */
function extractPictureElements($: CheerioAPI): PictureElementInfo[] {
  const pictures: PictureElementInfo[] = [];

  $('picture').each((_, element) => {
    const $el = $(element);
    const $img = $el.find('img');
    const $sources = $el.find('source');

    const sourceTypes: string[] = [];
    $sources.each((_, source) => {
      const type = $(source).attr('type');
      if (type) sourceTypes.push(type);
    });

    pictures.push({
      hasImgFallback: $img.length > 0,
      sourceCount: $sources.length,
      imgSrc: $img.attr('src'),
      sourceTypes,
    });
  });

  return pictures;
}

/**
 * Result of fetching a URL with redirect tracking
 */
export interface RedirectResult {
  /** Final URL after all redirects */
  finalUrl: string;
  /** HTTP status code of final response */
  statusCode: number;
  /** Number of redirects followed */
  redirectCount: number;
  /** Chain of URLs followed */
  chain: string[];
}

/**
 * Fetch URL with redirect tracking (no auto-follow)
 * @param url - URL to check
 * @param timeout - Request timeout in milliseconds (default: 10000)
 * @param maxRedirects - Maximum redirects to follow (default: 5)
 * @returns RedirectResult with final URL and redirect chain
 */
export async function fetchUrlWithRedirects(
  url: string,
  timeout = 10000,
  maxRedirects = 20,
  signal?: AbortSignal
): Promise<RedirectResult> {
  const normalized = new URL(url);
  normalized.hash = '';
  const known = currentNetworkSession()?.pages.get(normalized.href);
  if (known && known.redirectCount <= maxRedirects) return known;
  // All callers use the same redirect budget so status and redirect rules share a probe.
  const key = JSON.stringify([normalized.href, timeout, getUserAgent(), maxRedirects]);
  return memoizeProbe(key, signal, async () => {
    const attempt = async (method: 'HEAD' | 'GET'): Promise<RedirectResult> => {
      const chain = [normalized.href];
      let currentUrl = normalized.href;
      const request = requestSignal(timeout, signal);
      try {
        for (let hop = 0; hop <= maxRedirects; hop++) {
          const response = await safeFetch(currentUrl, {
            method, signal: request.signal, headers: { 'User-Agent': getUserAgent() }, redirect: 'manual',
          });
          const location = [301, 302, 303, 307, 308].includes(response.status) ? response.headers.get('location') : null;
          await response.body?.cancel();
          if (!location) return { finalUrl: currentUrl, statusCode: response.status, redirectCount: chain.length - 1, chain };
          const next = new URL(location, currentUrl).href;
          if (chain.includes(next) || hop === maxRedirects) break;
          chain.push(next);
          currentUrl = next;
        }
        return { finalUrl: currentUrl, statusCode: 0, redirectCount: chain.length - 1, chain };
      } catch (error) {
        rethrowIfAborted(error, signal);
        return { finalUrl: currentUrl, statusCode: 0, redirectCount: chain.length - 1, chain };
      } finally { request.dispose(); }
    };
    const head = await attempt('HEAD');
    if (head.statusCode > 0 && head.statusCode < 400) return head;
    const get = await attempt('GET');
    // A failed confirmation cannot certify a stale HEAD error as a broken link.
    return get;
  });
}

/**
 * Build full AuditContext from fetch result
 * @param url - The URL that was fetched
 * @param fetchResult - Result from fetchPage
 * @param cwv - Optional Core Web Vitals metrics
 * @returns Complete AuditContext object
 */
export function createAuditContext(
  url: string,
  fetchResult: FetchResult,
  cwv: CoreWebVitals = {}
): AuditContext {
  const { html, $, headers, statusCode, responseTime, cookies, redirectChain } = fetchResult;
  const finalUrl = fetchResult.finalUrl ?? redirectChain?.at(-1)?.url ?? url;
  let documentBaseUrl = finalUrl;
  const base = $('base[href]').first().attr('href');
  if (base !== undefined) {
    try {
      const resolved = new URL(base, finalUrl);
      if (['http:', 'https:'].includes(resolved.protocol)) documentBaseUrl = resolved.href;
    } catch { /* Invalid base falls back to the document address. */ }
  }
  const { links, invalidLinks } = extractLinks($, documentBaseUrl, finalUrl);
  const specialLinks = extractSpecialLinks($);

  return {
    url: finalUrl,
    requestedUrl: url,
    documentBaseUrl,
    html,
    $,
    headers,
    statusCode,
    responseTime,
    cwv,
    ...(fetchResult.tls && { tls: fetchResult.tls }),
    links,
    images: extractImages($, documentBaseUrl),
    invalidLinks,
    specialLinks,
    figures: extractFigures($),
    inlineSvgs: extractInlineSvgs($),
    pictureElements: extractPictureElements($),
    // Passed through as-is: undefined means unknown, [] means none were set.
    ...(cookies !== undefined && { cookies }),
    // Only present when the caller asked fetchPage to track redirects; the
    // redirect rules treat its absence as unmeasured rather than "no hops".
    ...(redirectChain !== undefined && { redirectChain }),
  };
}
