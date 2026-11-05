import { describe, expect, it } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { load } from 'cheerio';
import { IssuesTable } from './components/IssuesTable.js';
import { RuleCard } from './components/RuleCard.js';
import type { AuditResult, RuleResult } from '../src/types.js';

const row = (status: RuleResult['status']): RuleResult => ({ ruleId: 'js-canonical-mismatch', status, score: status === 'fail' ? 0 : 50, weight: 10, message: 'Canonical changed', details: { rawCanonical: 'https://example.com/raw', renderedCanonical: 'https://example.com/rendered' } });
const audit = (results: RuleResult[]): AuditResult => ({ url: 'https://example.com/', timestamp: new Date().toISOString(), overallScore: 80, crawledPages: 100, categoryResults: [{ categoryId: 'js', score: 80, passCount: 0, warnCount: 0, failCount: 1, results }] });

describe('report evidence and counts', () => {
  it('uses stored affected counts and consistent worst severity', () => {
    const stored = { ...row('fail'), totalPages: 100, measuredPages: 100, affectedPages: 37, failPages: 37, warnPages: 0, priority: 1 };
    const $ = load(renderToStaticMarkup(createElement(IssuesTable, { result: audit([stored]) })));
    expect($('tbody td').last().text()).toBe('37');
    for (const rows of [[row('warn'), row('fail')], [row('fail'), row('warn')]]) {
      const $table = load(renderToStaticMarkup(createElement(IssuesTable, { result: audit(rows) })));
      expect($table('tbody td').eq(2).text()).toBe('Failed');
    }
  });
  it('shows raw and rendered canonical evidence immediately', () => {
    const html = renderToStaticMarkup(createElement(RuleCard, { rule: row('fail') }));
    expect(html).toContain('https://example.com/raw');
    expect(html).toContain('https://example.com/rendered');
  });
  it('keeps an explicit empty value when rendering removed the canonical', () => {
    const input = { ...row('fail'), details: { rawCanonical: 'https://example.com/raw', renderedCanonical: null } };
    const html = renderToStaticMarkup(createElement(RuleCard, { rule: input }));
    expect(html).toContain('Rendered Canonical');
    expect(html).toContain('No value');
  });
  it('shows measurement advice rather than site-fix advice for unmeasured checks', () => {
    const html = renderToStaticMarkup(createElement(RuleCard, { rule: { ...row('not-measured'), weight: 0 }, metadata: { name: 'Canonical', description: 'Canonical', fix: 'Remove canonical conflict' } }));
    expect(html).not.toContain('How to Fix');
    expect(html).not.toContain('Remove canonical conflict');
    expect(html).toContain('collect the required data');
  });
});
