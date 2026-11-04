import { describe, it, expect } from 'vitest';
import { sanitizeForOutput, sanitizeText } from './sanitize.js';

describe('sensitive output boundaries', () => {
  it('redacts nested URLs, messages and headers without mutating the input', () => {
    const credential = ['review-user', 'dummy-password'].join(':');
    const url = `https://${credential}@example.com/path?token=dummy-token&q=seo`;
    const input = { url, details: [{ pageUrl: url }], message: `Failed at ${url}`, headers: { authorization: 'Bearer dummy-auth', 'set-cookie': 'sid=dummy-cookie' } };
    const output = JSON.stringify(sanitizeForOutput(input));
    for (const secret of ['dummy-password', 'dummy-token', 'dummy-auth', 'dummy-cookie']) expect(output).not.toContain(secret);
    expect(output).toContain('q=seo');
    expect(input.url).toBe(url);
    expect(sanitizeText(`Unsupported ftp://${credential}@example.com/`)).not.toContain('dummy-password');
    expect(sanitizeForOutput(new Error(`Failed at ${url}`)).message).not.toContain('dummy-password');
    expect(input.headers.authorization).toBe('Bearer dummy-auth');
  });

  it('leaves ordinary diagnostics and URLs intact', () => {
    expect(sanitizeText('Missing password field; https://example.com/?page=2')).toBe('Missing password field; https://example.com/?page=2');
    expect(sanitizeForOutput({ measured: false, value: 0, date: new Date(0) }).date).toEqual(new Date(0));
  });
});
