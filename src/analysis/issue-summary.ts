import type { CategoryResult, RuleResult, RuleStatus } from '../types.js';
import { getCategoryById } from '../categories/index.js';
import { isNotMeasured } from '../rules/define-rule.js';
import type { CountLedger } from '../dashboard/counts.js';

/** Shared, browser-safe counts for live page rows and stored rule summaries. */
export interface IssueSummary extends RuleResult {
  categoryId: string;
  totalPages: number;
  measuredPages: number;
  affectedPages: number;
  failPages: number;
  warnPages: number;
  priority: number;
  pages: string[];
}

const RANK: Record<RuleStatus, number> = { 'not-measured': -1, pass: 0, warn: 1, fail: 2 };

/** Read assessments retained in legacy-compatible details storage. */
export function readAssessment(row: Pick<RuleResult, 'details' | 'confidence' | 'severity' | 'evidence'>): Pick<RuleResult, 'confidence' | 'severity' | 'evidence'> {
  const stored = row.details?._assessment as Partial<RuleResult> | undefined;
  const confidence = row.confidence ?? stored?.confidence;
  const severity = row.severity ?? stored?.severity;
  const evidence = row.evidence ?? stored?.evidence;
  return {
    confidence: confidence === 'observed' || confidence === 'heuristic' ? confidence : undefined,
    severity: severity && ['critical', 'error', 'recommendation', 'observation'].includes(severity) ? severity : undefined,
    evidence: evidence && ['raw-html', 'rendered-dom', 'http', 'crawl-graph'].includes(evidence.source) ? evidence : undefined,
  };
}

/** Keep legacy weight-zero results out of measured counts on every surface. */
export function displayStatus(result: RuleResult): RuleStatus {
  return isNotMeasured(result) ? 'not-measured' : result.status;
}

/** Summarize each rule once, counting passes in its measured denominator. */
export function summarizeRules(categories: CategoryResult[]): IssueSummary[] {
  const groups = new Map<string, IssueSummary>();
  const storedPriorities = new Map<string, number>();
  const pages = new Map<string, Set<string>>();
  for (const category of categories) {
    for (const original of category.results) {
      const row = { ...original, ...readAssessment(original) };
      const stored = row as RuleResult & Partial<IssueSummary>;
      const key = `${category.categoryId}:${row.ruleId}`;
      const status = displayStatus(row);
      let group = groups.get(key);
      if (!group) {
        group = { ...row, status, categoryId: category.categoryId, totalPages: 0, measuredPages: 0, affectedPages: 0, failPages: 0, warnPages: 0, priority: 0, pages: [] };
        groups.set(key, group);
        pages.set(key, new Set());
      }
      const measured = status !== 'not-measured';
      group.totalPages += stored.totalPages ?? 1;
      group.measuredPages += stored.measuredPages ?? (measured ? 1 : 0);
      group.affectedPages += stored.affectedPages ?? (status === 'fail' || status === 'warn' ? 1 : 0);
      group.failPages += stored.failPages ?? (status === 'fail' ? stored.affectedPages ?? 1 : 0);
      group.warnPages += stored.warnPages ?? (status === 'warn' ? stored.affectedPages ?? 1 : 0);
      const currentPage = String(row.details?.pageUrl ?? row.details?.url ?? '');
      if ((status === 'fail' || status === 'warn' || status === 'not-measured') && /^https?:\/\//.test(currentPage)) pages.get(key)!.add(currentPage);
      if (status !== 'pass') for (const sample of (row as RuleResult & { samplePages?: Array<string | { pageUrl: string }> }).samplePages ?? []) {
        const page = typeof sample === 'string' ? sample : sample.pageUrl;
        if (/^https?:\/\//.test(page)) pages.get(key)!.add(page);
      }
      // Worst status wins, independent of encounter order. Choose a stable
      // representative at equal severity so page ordering cannot change it.
      if (RANK[status] > RANK[group.status] || RANK[status] === RANK[group.status] && row.message.localeCompare(group.message) < 0) {
        group.status = status; group.message = row.message; group.details = row.details; group.score = row.score;
        group.confidence = row.confidence; group.evidence = row.evidence; group.severity = row.severity; group.weight = row.weight;
      }
      if (typeof stored.priority === 'number') storedPriorities.set(key, stored.priority);
    }
  }
  for (const [key, group] of groups) {
    group.pages = [...pages.get(key)!].sort();
    const severity = group.status === 'fail' ? 1 : group.status === 'warn' ? 0.5 : 0;
    group.priority = storedPriorities.get(key) ?? (group.measuredPages > 0
      ? (group.weight ?? 1) * (getCategoryById(group.categoryId)?.weight ?? 0) * severity * Math.min(1, group.affectedPages / group.measuredPages) : 0);
  }
  return [...groups.values()].sort((a, b) => RANK[b.status] - RANK[a.status] || b.priority - a.priority || b.affectedPages - a.affectedPages || a.ruleId.localeCompare(b.ruleId));
}

/** Failures are not all critical incidents; only explicit critical evidence earns that label. */
export function issueLabel(result: Pick<RuleResult, 'status' | 'severity' | 'confidence'>): string {
  if (result.status === 'not-measured') return 'Not measured';
  if (result.severity === 'critical') return 'Critical';
  if (result.confidence === 'heuristic' && result.status !== 'pass') return 'Needs review';
  return result.status === 'fail' ? 'Failed' : result.status === 'warn' ? 'Warning' : 'Passed';
}

/** Preserve units: a rule and its per-page evaluations are different counts. */
export function summarizeCounts(categories: CategoryResult[]): { rules: CountLedger; evaluations: CountLedger } {
  const empty = (): CountLedger => ({ pass: 0, warn: 0, fail: 0, notMeasured: 0, total: 0 });
  const rules = empty(), evaluations = empty();
  for (const row of summarizeRules(categories)) {
    rules.total++;
    if (row.status === 'not-measured') rules.notMeasured++;
    else rules[row.status]++;
    evaluations.total += row.totalPages;
    evaluations.notMeasured += row.totalPages - row.measuredPages;
    evaluations.fail += row.failPages;
    evaluations.warn += row.warnPages;
    evaluations.pass += Math.max(0, row.measuredPages - row.failPages - row.warnPages);
  }
  return { rules, evaluations };
}
