import { describe, it, expect, vi, afterEach } from 'vitest';
import { createServer, request } from 'node:http';
import { connect } from 'node:net';
import type { AddressInfo } from 'node:net';
import type { lookup } from 'node:dns';
import { isPublicAddress, policyLookup, safeFetch, withNetworkSession, NetworkSession, validateNetworkUrl } from './network.js';
import { fetchUrl, fetchUrlWithRedirects } from './fetcher.js';
import { createBrowserProxy } from './browser-proxy.js';

afterEach(() => vi.unstubAllGlobals());

describe('egress policy', () => {
  it.each(['127.0.0.1','10.0.0.1','172.16.0.1','192.168.1.1','169.254.169.254','100.64.0.1','0.0.0.0','224.0.0.1','::1','fc00::1','fe80::1','::ffff:127.0.0.1','2002:7f00:1::'])('rejects non-public address %s', (ip) => {
    expect(isPublicAddress(ip)).toBe(false);
  });
  it.each(['http://2130706433/', 'http://0x7f000001/', 'http://[::ffff:7f00:1]/', 'http://localhost/'])('rejects alternate loopback spelling %s', (url) => {
    expect(() => validateNetworkUrl(url)).toThrow('Network policy');
  });
  it.each(['8.8.8.8','1.1.1.1','2606:4700:4700::1111'])('accepts global address %s', (ip) => expect(isPublicAddress(ip)).toBe(true));

  it('checks the DNS answer used by each socket connection, including rebinding', async () => {
    let resolutions = 0;
    const resolver = ((_host: string, _options: unknown, callback: Function) => callback(null, [{ address: resolutions++ ? '127.0.0.1' : '8.8.8.8', family: 4 }])) as typeof lookup;
    const resolve = policyLookup(false, resolver);
    const lookupOne = () => new Promise((done, reject) => resolve('rebind.test', { all: true }, (error, addresses) => error ? reject(error) : done(addresses)));
    await expect(lookupOne()).resolves.toEqual([{ address: '8.8.8.8', family: 4 }]);
    await expect(lookupOne()).rejects.toThrow('Network policy');
  });

  it('rejects a public-to-private redirect before requesting the private target', async () => {
    const fetch = vi.fn(async () => new Response('', { status: 302, headers: { location: 'http://127.0.0.1/private' } }));
    vi.stubGlobal('fetch', fetch);
    await expect(safeFetch('https://public.example/')).rejects.toThrow('Network policy');
    expect(fetch).toHaveBeenCalledTimes(1);
  });
});

describe('run-scoped probes', () => {
  it('shares in-flight status and redirect checks and starts fresh for the next audit', async () => {
    const fetch = vi.fn(async () => new Response(null, { status: 200 }));
    vi.stubGlobal('fetch', fetch);
    const run = () => withNetworkSession({}, () => Promise.all([
      fetchUrl('https://example.com/a#one'), fetchUrl('https://example.com/a#two'), fetchUrlWithRedirects('https://example.com/a'),
    ]));
    const results = await run();
    expect(results[0]).toBe(200);
    expect(fetch).toHaveBeenCalledTimes(1);
    await run();
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it('confirms HEAD errors with GET and does not retain unmeasured failures', async () => {
    const fetch = vi.fn(async (_url, init) => new Response(null, { status: init.method === 'HEAD' ? 405 : 200 }));
    vi.stubGlobal('fetch', fetch);
    await withNetworkSession({}, async () => {
      expect(await fetchUrl('https://example.com/')).toBe(200);
      expect(await fetchUrl('https://example.com/')).toBe(200);
    });
    expect(fetch.mock.calls.map((args) => args[1].method)).toEqual(['HEAD','GET']);
  });

  it('retries a failed probe on the next call within the run', async () => {
    let calls = 0;
    vi.stubGlobal('fetch', vi.fn(async () => {
      if (++calls <= 2) throw new Error('temporary failure');
      return new Response(null, { status: 200 });
    }));
    await withNetworkSession({}, async () => {
      expect(await fetchUrl('https://example.com/')).toBe(0);
      expect(await fetchUrl('https://example.com/')).toBe(200);
    });
    expect(calls).toBe(3);
  });
  it('enforces per-host concurrency and cancels queued work', async () => {
    const controller = new AbortController();
    const session = new NetworkSession({ concurrency: 2, perHostConcurrency: 1 });
    let release!: () => void;
    const first = session.schedule(new URL('https://example.com/a'), undefined, () => new Promise<void>((resolve) => { release = resolve; }));
    const queued = session.schedule(new URL('https://example.com/b'), controller.signal, async () => { throw new Error('should not start'); });
    controller.abort(new Error('cancelled'));
    await expect(queued).rejects.toThrow('cancelled');
    release(); await first; await session.agent.destroy();
  });
});

describe('browser egress proxy', () => {
  it('blocks private HTTP, CONNECT and WebSocket destinations before they receive traffic', async () => {
    let hits = 0;
    const target = createServer((_req, res) => { hits++; res.end('private'); });
    await new Promise<void>((resolve) => target.listen(0, '127.0.0.1', resolve));
    const port = (target.address() as AddressInfo).port;
    const proxy = await createBrowserProxy(false);
    try {
      const proxyUrl = new URL(proxy.url);
      const get = (path: string, headers = {}) => new Promise<number>((resolve, reject) => {
        const req = request({ hostname: proxyUrl.hostname, port: proxyUrl.port, path, headers }, (res) => { res.resume(); resolve(res.statusCode!); });
        req.on('error', reject); req.end();
      });
      expect(await get(`http://127.0.0.1:${port}/`)).toBe(403);
      expect(await get(`ws://127.0.0.1:${port}/`, { connection: 'Upgrade', upgrade: 'websocket' })).toBe(403);
      const tunnel = await new Promise<string>((resolve, reject) => {
        const socket = connect(Number(proxyUrl.port), proxyUrl.hostname, () => socket.write(`CONNECT 127.0.0.1:${port} HTTP/1.1\r\nHost: 127.0.0.1\r\n\r\n`));
        socket.once('data', (data) => { resolve(data.toString()); socket.destroy(); });
        socket.once('error', reject);
      });
      expect(tunnel).toContain('403');
      expect(hits).toBe(0);
    } finally { await proxy.close(); await new Promise<void>((resolve) => target.close(() => resolve())); }
  });

  it('permits an explicitly opted-in local audit', async () => {
    const target = createServer((_req, res) => res.end('allowed'));
    await new Promise<void>((resolve) => target.listen(0, '127.0.0.1', resolve));
    try {
      const url = `http://127.0.0.1:${(target.address() as AddressInfo).port}/`;
      await expect(safeFetch(url)).rejects.toThrow('Network policy');
      await withNetworkSession({ allowPrivate: true }, async () => expect(await (await safeFetch(url)).text()).toBe('allowed'));
    } finally { target.closeAllConnections(); await new Promise<void>((resolve) => target.close(() => resolve())); }
  });
});
