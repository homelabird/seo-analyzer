import { describe, expect, it } from 'vitest';
import { summarizeRules } from './issue-summary.js';
import type { CategoryResult, RuleResult } from '../types.js';

const row = (status: RuleResult['status'], i: number): RuleResult => ({ ruleId: 'core-title-present', status, score: status === 'fail' ? 0 : status === 'warn' ? 50 : 100, weight: 25, message: 'Title', details: { pageUrl: `https://example.com/${i}` } });
const category = (results: RuleResult[]): CategoryResult[] => [{ categoryId: 'core', score: 90, passCount: 0, warnCount: 0, failCount: 0, results }];

describe('cross-surface issue counts', () => {
  it('ranks one affected page against all 100 measured pages', () => {
    const [result] = summarizeRules(category([row('fail', 0), ...Array.from({ length: 99 }, (_, i) => row('pass', i + 1))]));
    expect(result).toMatchObject({ measuredPages: 100, affectedPages: 1, failPages: 1, priority: 2.75 });
  });
  it('keeps the worst status regardless of order', () => {
    for (const rows of [[row('warn', 0), row('fail', 1)], [row('fail', 1), row('warn', 0)]]) {
      expect(summarizeRules(category(rows))[0]).toMatchObject({ status: 'fail', affectedPages: 2, failPages: 1, warnPages: 1 });
    }
  });
  it('uses stored counts rather than treating a summary as one page', () => {
    const result = { ...row('fail', 0), totalPages: 100, measuredPages: 100, affectedPages: 37, failPages: 12, warnPages: 25, priority: 101.75 };
    expect(summarizeRules(category([result]))[0]).toMatchObject({ totalPages: 100, measuredPages: 100, affectedPages: 37, failPages: 12, warnPages: 25, priority: 101.75 });
  });
});
