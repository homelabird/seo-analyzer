import type { AuditContext } from '../../types.js';
import { defineRule, pass, fail, notMeasured } from '../define-rule.js';

/** @deprecated Comparisons are now prepared per crawl; no module state remains. */
export function resetDuplicateContentRegistry(): void {}

/** @deprecated No cross-audit state is retained. */
export function getDuplicateContentRegistryStats(): { totalHashes: number } { return { totalHashes: 0 }; }

/** Compare against the completed crawl so every group member receives the same verdict. */
export const duplicateExactRule = defineRule({
  id: 'content-duplicate-exact',
  name: 'Exact Duplicate Content',
  description:
    'Detects exact duplicate content across crawled pages using content hashing',
  category: 'content',
  weight: 8,
  run: async (context: AuditContext) => {
    // A single-page run has no independent content sample to compare.
    if (!context.site) {
      return notMeasured('content-duplicate-exact', 'Duplicate content detection needs other pages to compare against - run with --crawl');
    }

    if (context.renderQuality?.state === 'incomplete') return notMeasured('content-duplicate-exact', 'Browser content was not ready for duplicate comparison');
    const comparison = context.duplicateComparison;
    if (comparison) {
      const { exact } = comparison;
      if (exact.comparablePages < 2) return notMeasured('content-duplicate-exact', 'At least two pages with sufficient content are required for duplicate comparison');
      const duplicate = exact.clusterUrls.length > 1;
      const details = { contentHash: exact.hash, textLength: comparison.textLength, comparablePages: exact.comparablePages,
        clusterSize: exact.clusterUrls.length, clusterUrls: exact.clusterUrls.slice(0, 50), representativeUrl: exact.clusterUrls[0],
        note: 'The representative is a stable display URL, not a recommended canonical. Review indexability and canonical intent before consolidating.' };
      return { ...(duplicate ? fail('content-duplicate-exact', 'Identical main content occurs on multiple crawled URLs', details) : pass('content-duplicate-exact', 'No exact main-content duplicates found in the crawl', details)),
        confidence: 'observed', severity: duplicate ? 'recommendation' : 'observation', evidence: { source: comparison.source, observed: exact.hash, expected: 'Unique main content or an intentional canonical relationship' } };
    }
    return notMeasured('content-duplicate-exact', 'Completed crawl comparisons are unavailable; prepare the page batch before running this rule');
  },
});
