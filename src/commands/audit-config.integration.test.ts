import { describe, it, expect, vi } from 'vitest';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runAudit, type AuditOptions } from './audit.js';
import { Auditor } from '../auditor.js';

const HTML = '<!doctype html><html><head><title>Fixture</title></head><body><h1>Fixture</h1><p>This local page provides sufficient text for a controlled crawl configuration test without any remote dependencies or external requests.</p></body></html>';

describe('CLI configuration reaches the real crawl', () => {
  it('uses TOML when flags are omitted, explicit flags when supplied, and rejects private starts by default', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'seomator-config-test-'));
    const priorExitCode = process.exitCode;
    let hits = 0;
    const server = createServer((req,res) => {
      hits++;
      res.setHeader('content-type','text/html');
      if (req.url !== '/') res.writeHead(404);
      res.end(HTML);
    });
    await new Promise<void>((resolve) => server.listen(0,'127.0.0.1',resolve));
    const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/`;
    vi.stubEnv('SEOMATOR_HOME',directory);
    vi.spyOn(process,'cwd').mockReturnValue(directory);
    const log = vi.spyOn(console,'log').mockImplementation(() => {});
    vi.spyOn(console,'error').mockImplementation(() => {});
    try {
      writeFileSync(join(directory,'seomator.toml'),'[crawler]\nmax_pages=50\nconcurrency=1\ntimeout_ms=7000\nallow_private=true\n');
      const options: AuditOptions = { json: false, crawl: true, verbose: false, cwv: false, refresh: false, resume: false, save: false, format: 'json', categories: ['legal'] };
      await runAudit(url,options);
      const first = JSON.parse(String(log.mock.calls.at(-1)?.[0]));
      expect(first.run).toMatchObject({maxPages:50,concurrency:1,timeout:7000,allowPrivate:true});
      expect(first.crawledPages).toBe(1);
      await runAudit(url,{...options,maxPages:1,concurrency:2,timeout:8000});
      const second = JSON.parse(String(log.mock.calls.at(-1)?.[0]));
      expect(second.run).toMatchObject({maxPages:1,concurrency:2,timeout:8000});
      const before = hits;
      await expect(new Auditor().auditWithCrawl(url)).rejects.toMatchObject({code:'network-policy'});
      expect(hits).toBe(before);
    } finally {
      process.exitCode = priorExitCode;
      vi.restoreAllMocks();vi.unstubAllEnvs();
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      rmSync(directory,{recursive:true,force:true});
    }
  });
});
