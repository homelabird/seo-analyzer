import { describe, it, expect } from 'vitest';
import type { Page, Request, Response } from 'playwright';
import { collectAssets, settleAssetSizes } from './playwright-fetcher.js';

/**
 * Minimal Playwright mocks: collectAssets only uses `page.on('response')` and,
 * per response, `status()`, `headers()`, `url()`, `request()` plus the
 * request's `resourceType()`, `redirectedFrom()` and `redirectedTo()`.
 */
interface MockRequestOptions {
  url: string;
  resourceType?: string;
  redirectedFrom?: Request | null;
  redirectedTo?: Request | null;
}

function mockRequest(options: MockRequestOptions): Request {
  return {
    url: () => options.url,
    resourceType: () => options.resourceType ?? 'script',
    redirectedFrom: () => options.redirectedFrom ?? null,
    redirectedTo: () => options.redirectedTo ?? null,
  } as unknown as Request;
}

function mockResponse(request: Request, status: number, headers: Record<string, string>): Response {
  return {
    request: () => request,
    status: () => status,
    headers: () => headers,
    url: () => request.url(),
  } as unknown as Response;
}

function mockPage(): { page: Page; emitResponse: (response: Response) => void } {
  let handler: ((response: Response) => void) | undefined;
  const page = {
    on: (event: string, cb: (response: Response) => void) => {
      if (event === 'response') handler = cb;
    },
  } as unknown as Page;
  return {
    page,
    emitResponse: (response) => handler?.(response),
  };
}

describe('collectAssets', () => {
  it('reads completed encoded response sizes without a Content-Length or another request', async () => {
    const handlers = new Map<string, (value: any) => void>();
    const page = { on: (event: string, callback: (value: any) => void) => handlers.set(event, callback) } as unknown as Page;
    const assets = collectAssets(page);
    const request = mockRequest({ url: 'https://example.com/chunked.js' });
    request.sizes = async () => ({ responseBodySize: 4200, responseHeadersSize: 100, requestBodySize: 0, requestHeadersSize: 100 });
    handlers.get('response')!(mockResponse(request, 200, {}));
    handlers.get('requestfinished')!(request);
    await settleAssetSizes(assets);
    expect(assets[0].transferBytes).toBe(4200);
  });

  it('keeps a failed size reading unknown', async () => {
    const handlers = new Map<string, (value: any) => void>();
    const page = { on: (event: string, callback: (value: any) => void) => handlers.set(event, callback) } as unknown as Page;
    const assets = collectAssets(page);
    const request = mockRequest({ url: 'https://example.com/failed.js' });
    request.sizes = async () => { throw new Error('Unavailable'); };
    handlers.get('response')!(mockResponse(request, 200, {}));
    handlers.get('requestfinished')!(request);
    await settleAssetSizes(assets);
    expect(assets[0].transferBytes).toBeUndefined();
  });
  it('records a normal asset with only the cache-relevant headers kept', () => {
    const { page, emitResponse } = mockPage();
    const assets = collectAssets(page);

    emitResponse(
      mockResponse(mockRequest({ url: 'https://example.com/app.css', resourceType: 'stylesheet' }), 200, {
        'content-type': 'text/css',
        'cache-control': 'max-age=3600',
        'content-encoding': 'gzip',
        'content-length': '1234',
        etag: '"abc"',
        expires: 'Wed, 21 Oct 2026 07:28:00 GMT',
        age: '12',
        server: 'nginx', // not cache/type-relevant: dropped
        'set-cookie': 'session=1', // not cache/type-relevant: dropped
      })
    );

    expect(assets).toHaveLength(1);
    expect(assets[0]).toEqual({
      url: 'https://example.com/app.css',
      resourceType: 'stylesheet',
      statusCode: 200,
      headers: {
        'content-type': 'text/css',
        'cache-control': 'max-age=3600',
        'content-encoding': 'gzip',
        'content-length': '1234',
        etag: '"abc"',
        expires: 'Wed, 21 Oct 2026 07:28:00 GMT',
        age: '12',
      },
      redirectChain: [],
      redirectLoop: false,
    });
  });

  it('excludes the main document', () => {
    const { page, emitResponse } = mockPage();
    const assets = collectAssets(page);

    emitResponse(
      mockResponse(mockRequest({ url: 'https://example.com/', resourceType: 'document' }), 200, {})
    );
    emitResponse(
      mockResponse(mockRequest({ url: 'https://example.com/logo.png', resourceType: 'image' }), 200, {})
    );

    expect(assets).toHaveLength(1);
    expect(assets[0].url).toBe('https://example.com/logo.png');
  });

  it('walks the redirect chain and records hop statuses in chronological order', () => {
    const { page, emitResponse } = mockPage();
    const assets = collectAssets(page);

    // old.css → 301 → moved.css → 302 → final.css (200)
    const hop1 = mockRequest({ url: 'https://example.com/old.css', resourceType: 'stylesheet' });
    const hop2 = mockRequest({
      url: 'https://example.com/moved.css',
      resourceType: 'stylesheet',
      redirectedFrom: hop1,
    });
    const final = mockRequest({
      url: 'https://example.com/final.css',
      resourceType: 'stylesheet',
      redirectedFrom: hop2,
    });
    (hop1 as { redirectedTo: () => Request }).redirectedTo = () => hop2;
    (hop2 as { redirectedTo: () => Request }).redirectedTo = () => final;

    // Hop responses fire before the final one; they are not assets themselves.
    emitResponse(mockResponse(hop1, 301, { 'cache-control': 'no-cache' }));
    emitResponse(mockResponse(hop2, 302, {}));
    emitResponse(mockResponse(final, 200, { 'content-type': 'text/css' }));

    expect(assets).toHaveLength(1);
    expect(assets[0].url).toBe('https://example.com/final.css');
    expect(assets[0].redirectChain).toEqual([
      { url: 'https://example.com/old.css', statusCode: 301 },
      { url: 'https://example.com/moved.css', statusCode: 302 },
    ]);
    expect(assets[0].redirectLoop).toBe(false);
  });

  it('detects a redirect loop', () => {
    const { page, emitResponse } = mockPage();
    const assets = collectAssets(page);

    // a.css → b.css → a.css (loop)
    const hop1 = mockRequest({ url: 'https://example.com/a.css', resourceType: 'stylesheet' });
    const hop2 = mockRequest({
      url: 'https://example.com/b.css',
      resourceType: 'stylesheet',
      redirectedFrom: hop1,
    });
    const final = mockRequest({
      url: 'https://example.com/a.css',
      resourceType: 'stylesheet',
      redirectedFrom: hop2,
    });
    (hop1 as { redirectedTo: () => Request }).redirectedTo = () => hop2;
    (hop2 as { redirectedTo: () => Request }).redirectedTo = () => final;

    emitResponse(mockResponse(hop1, 302, {}));
    emitResponse(mockResponse(hop2, 302, {}));
    emitResponse(mockResponse(final, 200, {}));

    expect(assets).toHaveLength(1);
    expect(assets[0].redirectLoop).toBe(true);
    // The walk stops at the repeated URL: the final request landed on a.css,
    // which the first hop already visited, so only b.css remains in the chain.
    expect(assets[0].redirectChain).toEqual([
      { url: 'https://example.com/b.css', statusCode: 302 },
    ]);
  });

  it('records error-status assets; the failure diagnosis stays in failedRequests', () => {
    const { page, emitResponse } = mockPage();
    const assets = collectAssets(page);

    emitResponse(
      mockResponse(mockRequest({ url: 'https://example.com/missing.js' }), 404, {})
    );

    expect(assets).toHaveLength(1);
    expect(assets[0].statusCode).toBe(404);
  });
});
