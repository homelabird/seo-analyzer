import { describe, it, expect } from 'vitest';
import { saveAuditToDatabase } from './save-audit.js';
import { makeAuditResult, tempDatabase } from './audits-db/test-fixtures.js';
import { getAuditDetail } from '../dashboard/queries.js';
import { renderJsonReport } from '../reporters/json.js';
import { renderHtmlReport } from '../reporters/html-reporter.js';
import { renderMarkdownReport } from '../reporters/markdown-reporter.js';
import { renderLlmReport } from '../reporters/llm-reporter.js';

describe('persistence and report boundaries', () => {
  it('removes nested credentials from every report and the database while keeping score explanations', () => {
    const db = tempDatabase();
    try {
      const auth = ['fixture-user','dummy-password'].join(':');
      const url = `https://${auth}@example.com/?access_token=dummy-token&q=seo`;
      const result = makeAuditResult(url, { core: { 'core-title': [{ pageUrl: url, status: 'warn', message: `Problem at ${url}` }] } });
      result.categoryResults[0]!.results[0]!.details!.headers = { authorization: 'Bearer dummy-auth', 'set-cookie': 'sid=dummy-cookie' };
      result.scoreCap = { uncappedScore: 80, caps: [{ id: 'noindex', ceiling: 20, reason: 'Page says noindex' }] };
      result.overallScore = 20;
      result.waivedCaps = [{ id: 'robots', ceiling: 20, reason: 'Staging exception' }];
      result.coverage = { detail: 'per-page', pages: [url], crawl: { complete: false, limitReached: true } };
      const saved = saveAuditToDatabase(result, { db: db.db });
      const detail = getAuditDetail(db.db, saved.auditId)!;
      expect(detail.result.scoreCap).toEqual(result.scoreCap);
      expect(detail.result.waivedCaps).toEqual(result.waivedCaps);
      expect(detail.result.coverage?.crawl).toEqual(result.coverage.crawl);
      for (const report of [renderJsonReport, renderHtmlReport, renderMarkdownReport, renderLlmReport]) {
        const output = report(result);
        for (const secret of ['dummy-password','dummy-token','dummy-auth','dummy-cookie']) expect(output).not.toContain(secret);
        expect(output).toContain('q=seo');
      }
      const stored = JSON.stringify({ audit: db.db.getAudit(saved.auditId), rows: db.db.getAllResults(saved.id), detail });
      for (const secret of ['dummy-password','dummy-token','dummy-auth','dummy-cookie']) expect(stored).not.toContain(secret);
      expect(result.url).toContain('dummy-password');
    } finally { db.cleanup(); }
  });
});
