import { createServer, request as httpRequest, type IncomingHttpHeaders } from 'node:http';
import { connect, type Socket } from 'node:net';
import { currentNetworkSession, policyLookup, validateNetworkUrl, isNetworkPolicyError } from './network.js';

/**
 * A per-render forward proxy. HTTP, HTTPS CONNECT and WebSocket upgrades all
 * connect through the checked DNS lookup; browsers never resolve target IPs.
 */
export async function createBrowserProxy(allowPrivate = currentNetworkSession()?.allowPrivate ?? false): Promise<{ url: string; close: () => Promise<void>; blockedCount: () => number }> {
  const sockets = new Set<Socket>();
  let blocked = 0;
  const lookup = policyLookup(allowPrivate);
  const server = createServer((req, res) => {
    let url: URL;
    try {
      url = validateNetworkUrl(req.url ?? '', allowPrivate);
      if (url.protocol !== 'http:' || url.username || url.password) throw new Error('Invalid proxy target');
    } catch { blocked++; res.writeHead(403); res.end('Blocked by audit network policy'); return; }
    const headers: IncomingHttpHeaders = { ...req.headers, host: url.host };
    delete headers['proxy-authorization'];
    delete headers['proxy-connection'];
    const upstream = httpRequest(url, { method: req.method, headers, lookup, timeout: 30_000 }, (response) => {
      res.writeHead(response.statusCode ?? 502, response.headers);
      response.pipe(res);
    });
    upstream.on('socket', (socket) => { sockets.add(socket); socket.on('close', () => sockets.delete(socket)); });
    upstream.on('error', (error) => { if (isNetworkPolicyError(error)) blocked++; if (!res.headersSent) res.writeHead(502); res.end(); });
    upstream.on('timeout', () => upstream.destroy());
    res.on('close', () => upstream.destroy());
    req.pipe(upstream);
  });
  server.on('connection', (socket) => { sockets.add(socket); socket.on('close', () => sockets.delete(socket)); socket.on('error', () => {}); });
  server.on('connect', (req, client, head) => {
    let url: URL;
    try {
      url = validateNetworkUrl(`https://${req.url}`, allowPrivate);
      if (url.username || url.password || url.pathname !== '/') throw new Error('Invalid CONNECT target');
    } catch { blocked++; client.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n'); return; }
    const upstream = connect({ host: url.hostname.replace(/^\[|\]$/g, ''), port: Number(url.port || 443), lookup });
    sockets.add(upstream);
    upstream.on('close', () => sockets.delete(upstream));
    upstream.setTimeout(30_000, () => upstream.destroy());
    upstream.on('connect', () => {
      client.write('HTTP/1.1 200 Connection Established\r\n\r\n');
      if (head.length) upstream.write(head);
      client.pipe(upstream); upstream.pipe(client);
    });
    upstream.on('error', (error) => { if (isNetworkPolicyError(error)) blocked++; client.destroy(); });
    client.on('close', () => upstream.destroy());
  });
  server.on('upgrade', (req, client, head) => {
    let url: URL;
    try {
      url = validateNetworkUrl((req.url ?? '').replace(/^ws:/, 'http:'), allowPrivate);
      if (url.protocol !== 'http:' || url.username || url.password) throw new Error('Invalid upgrade target');
    } catch { blocked++; client.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n'); return; }
    const upstream = httpRequest(url, { method: 'GET', headers: { ...req.headers, host: url.host }, lookup, timeout: 30_000 });
    upstream.on('upgrade', (response, socket, upstreamHead) => {
      sockets.add(socket); socket.on('close', () => sockets.delete(socket));
      client.write(`HTTP/1.1 ${response.statusCode} Switching Protocols\r\n` +
        Object.entries(response.headers).map(([key, value]) => `${key}: ${value}\r\n`).join('') + '\r\n');
      if (head.length) socket.write(head);
      if (upstreamHead.length) client.write(upstreamHead);
      client.pipe(socket); socket.pipe(client);
      socket.on('error', () => client.destroy());
      client.on('close', () => socket.destroy());
    });
    upstream.on('response', (response) => { response.resume(); client.destroy(); });
    upstream.on('error', (error) => { if (isNetworkPolicyError(error)) blocked++; client.destroy(); });
    upstream.on('timeout', () => upstream.destroy());
    client.on('close', () => upstream.destroy());
    upstream.end();
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => { server.off('error', reject); resolve(); });
  });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Proxy did not bind');
  let closed = false;
  return {
    url: `http://127.0.0.1:${address.port}`,
    blockedCount: () => blocked,
    close: async () => {
      if (closed) return;
      closed = true;
      for (const socket of sockets) socket.destroy();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}
