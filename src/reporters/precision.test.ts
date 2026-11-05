import { describe, expect, it } from 'vitest';
import { collectFindings } from './findings.js';
import { renderHtmlReport } from './html-reporter.js';
import { renderLlmReport } from './llm-reporter.js';
import { renderMarkdownReport } from './markdown-reporter.js';
import { saveAuditToDatabase } from '../storage/save-audit.js';
import { tempDatabase } from '../storage/audits-db/test-fixtures.js';
import { getAuditDetail } from '../dashboard/queries.js';
import type { AuditResult, RuleResult } from '../types.js';
import '../rules/loader.js';

const rawUrl = `https://example.com/raw/${'a'.repeat(150)}`;
const renderedUrl = `https://example.com/rendered/${'b'.repeat(150)}`;
const row = (status: RuleResult['status'], i: number): RuleResult => ({ ruleId: 'core-title-present', status, score: status === 'fail' ? 0 : status === 'warn' ? 50 : 100, weight: 25,
  message: 'Title evidence', details: { pageUrl: `https://example.com/${i}`, rawCanonical: rawUrl, renderedCanonical: renderedUrl },
  confidence: 'heuristic', severity: 'recommendation', evidence: { source: 'rendered-dom', observed: { raw: rawUrl, rendered: renderedUrl } } });
const audit = (results: RuleResult[]): AuditResult => ({ url: 'https://example.com/', timestamp: '2026-11-05T00:00:00.000Z', overallScore: 80, crawledPages: results.length,
  categoryResults: [{ categoryId: 'core', score: 80, passCount: results.filter(r => r.status === 'pass').length, warnCount: results.filter(r => r.status === 'warn').length, failCount: results.filter(r => r.status === 'fail').length, results }] });

describe('report precision across export and storage', () => {
  it('uses passed pages in the detailed findings denominator', () => {
    const findings = collectFindings(audit(Array.from({ length: 100 }, (_, i) => row(i === 0 ? 'fail' : 'pass', i))));
    expect(findings[0]).toMatchObject({ pageCount: 1, measuredPages: 100, priority: 2.75 });
  });
  it('retains both long canonical URLs in every export and identifies heuristic evidence', () => {
    const input = audit([row('fail', 0)]);
    for (const render of [renderHtmlReport, renderLlmReport, renderMarkdownReport]) {
      const report = render(input);
      expect(report).toContain(rawUrl);
      expect(report).toContain(renderedUrl);
      expect(report.toLowerCase()).toContain('heuristic');
    }
    expect(renderLlmReport(input)).not.toContain('severity="critical"');
  });
  it('round-trips mixed page counts and assessments without a database migration', () => {
    const t = tempDatabase();
    try {
      const input = audit(Array.from({ length: 100 }, (_, i) => row(i < 37 ? 'fail' : i < 47 ? 'warn' : 'pass', i)));
      const saved = saveAuditToDatabase(input, { db: t.db });
      const detail = getAuditDetail(t.db, saved.auditId)!;
      expect(detail.result.categoryResults[0].results[0]).toMatchObject({ measuredPages: 100, affectedPages: 47, failPages: 37, warnPages: 10, confidence: 'heuristic', evidence: { source: 'rendered-dom' } });
      const html = renderHtmlReport(detail.result);
      expect(html).toContain('47 pages affected');
      expect(html).toContain('Needs review');
      expect(html).toContain(renderedUrl);
      const markdown = renderMarkdownReport(detail.result);
      expect(markdown).toContain('| Total Checks | 1 | 100 |');
      expect(markdown).toContain('| :x: Failures | 1 | 37 |');
      expect(markdown).toContain('| :warning: Warnings | 0 | 10 |');
    } finally { t.cleanup(); }
  });
});
