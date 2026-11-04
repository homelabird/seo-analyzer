import { describe, it, expect } from 'vitest';
import { load } from 'cheerio';
import { createAuditContext } from './crawler/fetcher.js';

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
