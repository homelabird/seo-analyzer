import { AsyncLocalStorage } from 'node:async_hooks';
import { lookup as dnsLookup } from 'node:dns';
import type { LookupOptions } from 'node:dns';
import { BlockList, isIP } from 'node:net';
import { TLSSocket } from 'node:tls';
import { Agent, buildConnector } from 'undici';
import { AuditError } from '../errors.js';
import { sanitizeText } from '../sanitize.js';

const MAX_REDIRECTS = 20;
const MAX_CACHE_ENTRIES = 10_000;
const blocked = new BlockList();
for (const [address, prefix] of [
  ['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8],
  ['169.254.0.0', 16], ['172.16.0.0', 12], ['192.0.0.0', 24], ['192.0.2.0', 24],
  ['192.168.0.0', 16], ['198.18.0.0', 15], ['198.51.100.0', 24], ['203.0.113.0', 24],
  ['224.0.0.0', 4], ['240.0.0.0', 4],
] as const) blocked.addSubnet(address, prefix, 'ipv4');
const globalV6 = new BlockList();
globalV6.addSubnet('2000::', 3, 'ipv6');
for (const [address, prefix] of [['2001::', 32], ['2001:db8::', 32], ['2002::', 16]] as const) {
  blocked.addSubnet(address, prefix, 'ipv6');
}

/** Only globally routable addresses may be contacted without explicit opt-in. */
export function isPublicAddress(address: string): boolean {
  const ip = address.replace(/^\[|\]$/g, '');
  const family = isIP(ip);
  if (family === 4) return !blocked.check(ip, 'ipv4');
  return family === 6 && globalV6.check(ip, 'ipv6') && !blocked.check(ip, 'ipv6');
}

/** A policy refusal is unavailable evidence, never a broken target. */
export class NetworkPolicyError extends AuditError {
  constructor(url: string) {
    super('network-policy', `Network policy blocked ${sanitizeText(url)}; private networks require --allow-private`);
    this.name = 'NetworkPolicyError';
  }
}

/** Recognise policy failures wrapped by the HTTP transport. */
export function isNetworkPolicyError(error: unknown): boolean {
  for (let depth = 0; error && depth < 5; depth++) {
    if (error instanceof NetworkPolicyError) return true;
    error = error instanceof Error ? error.cause : undefined;
  }
  return false;
}

/** Validate protocol and literal IP before any connection or redirect hop. */
export function validateNetworkUrl(input: string | URL, allowPrivate = false): URL {
  const url = new URL(input);
  if (!['http:', 'https:'].includes(url.protocol)) throw new NetworkPolicyError(url.href);
  const hostname = url.hostname.replace(/^\[|\]$/g, '');
  if (!allowPrivate && ((isIP(hostname) && !isPublicAddress(hostname)) || /^(?:localhost|.*\.localhost)$/i.test(hostname))) {
    throw new NetworkPolicyError(url.href);
  }
  return url;
}

/** Resolve once and return the checked address directly to the socket connector. */
export function policyLookup(allowPrivate: boolean, lookup = dnsLookup): typeof dnsLookup {
  return ((hostname: string, options: LookupOptions, callback: (...args: any[]) => void) => {
    lookup(hostname, { all: true, verbatim: true, family: options.family }, (error, addresses) => {
      if (error) { callback(error); return; }
      if (!addresses.length || (!allowPrivate && addresses.some((entry) => !isPublicAddress(entry.address)))) {
        callback(new NetworkPolicyError(hostname));
        return;
      }
      if (options.all) callback(null, addresses);
      else callback(null, addresses[0]!.address, addresses[0]!.family);
    });
  }) as typeof dnsLookup;
}

export interface NetworkOptions {
  allowPrivate?: boolean;
  concurrency?: number;
  perHostConcurrency?: number;
  delayMs?: number;
  perHostDelayMs?: number;
  signal?: AbortSignal;
}

export interface TlsEvidence { validTo?: string; protocol?: string }

/** Request scheduling and caches live only for one audit, including all pages. */
export class NetworkSession {
  readonly allowPrivate: boolean;
  readonly agent: Agent;
  readonly cache = new Map<string, Promise<unknown>>();
  readonly tls = new Map<string, TlsEvidence>();
  readonly pages = new Map<string, { finalUrl: string; statusCode: number; redirectCount: number; chain: string[] }>();
  private active = 0;
  private hosts = new Map<string, number>();
  private waiters = new Set<() => void>();
  private nextGlobal = 0;
  private nextHost = new Map<string, number>();
  constructor(readonly options: NetworkOptions = {}) {
    this.options = { ...options, concurrency: Math.max(1, options.concurrency ?? 8), perHostConcurrency: Math.max(1, options.perHostConcurrency ?? 2) };
    this.allowPrivate = options.allowPrivate === true;
    const connect = buildConnector({ lookup: policyLookup(this.allowPrivate), timeout: 10_000 });
    this.agent = new Agent({ connections: this.options.perHostConcurrency, connect: (options, callback) => {
      connect(options, (error, socket) => {
        if (error) { callback(error, null); return; }
        if (socket instanceof TLSSocket && socket.authorized) {
          const host = options.hostname.includes(':') ? `[${options.hostname.replace(/[\[\]]/g, '')}]` : options.hostname;
          const target = new URL(`${options.protocol}//${host}`);
          target.port = options.port;
          const origin = target.origin;
          this.tls.set(origin, { validTo: socket.getPeerCertificate().valid_to, protocol: socket.getProtocol() ?? undefined });
        }
        callback(null, socket);
      });
    } });
  }

  async schedule<T>(url: URL, signal: AbortSignal | null | undefined, task: () => Promise<T>): Promise<T> {
    const host = url.host;
    const check = () => {
      signal?.throwIfAborted();
      this.options.signal?.throwIfAborted();
    };
    for (;;) {
      check();
      const hostActive = this.hosts.get(host) ?? 0;
      if (this.active < (this.options.concurrency ?? 8) && hostActive < (this.options.perHostConcurrency ?? 2)) {
        this.active++;
        this.hosts.set(host, hostActive + 1);
        break;
      }
      await new Promise<void>((resolve, reject) => {
        const wake = () => { cleanup(); resolve(); };
        const abort = () => { cleanup(); reject(signal?.reason ?? this.options.signal?.reason); };
        const cleanup = () => {
          this.waiters.delete(wake);
          signal?.removeEventListener('abort', abort);
          this.options.signal?.removeEventListener('abort', abort);
        };
        this.waiters.add(wake);
        signal?.addEventListener('abort', abort, { once: true });
        this.options.signal?.addEventListener('abort', abort, { once: true });
      });
    }
    try {
      const now = Date.now();
      const start = Math.max(now, this.nextGlobal, this.nextHost.get(host) ?? 0);
      this.nextGlobal = start + (this.options.delayMs ?? 0);
      this.nextHost.set(host, start + (this.options.perHostDelayMs ?? 0));
      if (start > now) await new Promise<void>((resolve, reject) => {
        const cleanup = () => { signal?.removeEventListener('abort', abort); this.options.signal?.removeEventListener('abort', abort); };
        const timer = setTimeout(() => { cleanup(); resolve(); }, start - now);
        const abort = () => { clearTimeout(timer); cleanup(); reject(signal?.reason ?? this.options.signal?.reason); };
        signal?.addEventListener('abort', abort, { once: true });
        this.options.signal?.addEventListener('abort', abort, { once: true });
      });
      check();
      return await task();
    } finally {
      this.active--;
      this.hosts.set(host, (this.hosts.get(host) ?? 1) - 1);
      for (const wake of [...this.waiters]) wake();
    }
  }
}

const sessions = new AsyncLocalStorage<NetworkSession>();
const publicSession = new NetworkSession();
/** Current audit's network controls; undefined outside an audit. */
export const currentNetworkSession = (): NetworkSession | undefined => sessions.getStore();

/** Run an audit with isolated caches and release all its sockets on exit. */
export async function withNetworkSession<T>(options: NetworkOptions, task: () => Promise<T>): Promise<T> {
  const session = new NetworkSession(options);
  try { return await sessions.run(session, task); }
  finally { await session.agent.destroy(); }
}

/** Coalesce compatible in-flight probes, and retain successful results for this run. */
export function memoizeProbe<T extends { statusCode: number }>(key: string, signal: AbortSignal | undefined, task: () => Promise<T>): Promise<T> {
  const session = currentNetworkSession();
  if (!session || (signal && signal !== session.options.signal)) return task();
  const existing = session.cache.get(key) as Promise<T> | undefined;
  if (existing) return existing;
  const pending = task().then((result) => {
    if (result.statusCode === 0) session.cache.delete(key);
    return result;
  }, (error) => { session.cache.delete(key); throw error; });
  if (session.cache.size < MAX_CACHE_ENTRIES) session.cache.set(key, pending);
  return pending;
}

/** Fetch through checked DNS, validating every redirect before connecting. */
export async function safeFetch(input: string | URL, init: RequestInit = {}): Promise<Response> {
  const session = currentNetworkSession() ?? publicSession;
  let url = validateNetworkUrl(input, session.allowPrivate);
  const headers = new Headers(init.headers);
  if (url.username || url.password) {
    headers.set('authorization', `Basic ${Buffer.from(`${decodeURIComponent(url.username)}:${decodeURIComponent(url.password)}`).toString('base64')}`);
    url.username = '';
    url.password = '';
  }
  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    const response = await session.schedule(url, init.signal, () => fetch(url.href, {
      ...init, headers: Object.fromEntries(headers), redirect: 'manual', dispatcher: session.agent,
    } as RequestInit));
    const location = [301, 302, 303, 307, 308].includes(response.status) ? response.headers.get('location') : null;
    if (!location || init.redirect === 'manual') {
      if (!response.url) Object.defineProperty(response, 'url', { value: url.href });
      return response;
    }
    await response.body?.cancel();
    if (init.redirect === 'error') throw new Error('Redirect not allowed');
    const next = validateNetworkUrl(new URL(location, url), session.allowPrivate);
    if (next.origin !== url.origin) { headers.delete('authorization'); headers.delete('cookie'); }
    url = next;
  }
  throw new Error(`Exceeded ${MAX_REDIRECTS} redirects`);
}

/** Bound decompressed response bytes before parsing untrusted HTML/XML. */
export async function readResponseBytes(response: Response, maxBytes = 8 * 1024 * 1024): Promise<Uint8Array> {
  if (!response.body) return new Uint8Array();
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > maxBytes) throw new Error(`Response exceeded ${maxBytes} byte limit`);
      chunks.push(value);
    }
  } finally { await reader.cancel().catch(() => {}); }
  return Buffer.concat(chunks);
}
