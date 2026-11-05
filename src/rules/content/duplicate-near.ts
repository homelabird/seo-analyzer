import type { AuditContext } from '../../types.js';
import { defineRule, pass, warn, fail, notMeasured } from '../define-rule.js';

import { NEAR_DUPLICATE_THRESHOLD as DUPLICATE_THRESHOLD, SIMILAR_CONTENT_THRESHOLD as SIMILAR_THRESHOLD } from '../../analysis/content-duplicates.js';

/** @deprecated Comparisons are now prepared per crawl; no module state remains. */
export function resetNearDuplicateRegistry(): void {}

/** @deprecated No cross-audit state is retained. */
export function getNearDuplicateRegistryStats(): { totalPages: number } { return { totalPages: 0 }; }

/** Compare against the completed crawl so every group member receives the same verdict. */
export const duplicateNearRule = defineRule({
  id: 'content-duplicate-near',
  name: 'Near-Duplicate Content',
  description:
    'Detects near-duplicate content across crawled pages using trigram similarity',
  category: 'content',
  weight: 7,
  run: async (context: AuditContext) => {
    // A single-page run has no independent content sample to compare.
    if (!context.site) {
      return notMeasured('content-duplicate-near', 'Near-duplicate detection needs other pages to compare against - run with --crawl');
    }

    if (context.renderQuality?.state === 'incomplete') return notMeasured('content-duplicate-near', 'Browser content was not ready for similarity comparison');
    const comparison = context.duplicateComparison;
    if (comparison) {
      const { near } = comparison;
      if (near.comparablePages < 2) return notMeasured('content-duplicate-near', 'At least two pages with sufficient main content are required for similarity comparison');
      const details = { comparablePages: near.comparablePages, highestSimilarity: Math.round(near.similarity * 1000) / 1000,
        mostSimilarUrl: near.mostSimilarUrl ?? null, clusterSize: near.clusterUrls.length, clusterUrls: near.clusterUrls.slice(0, 50),
        sampledShingles: near.sampledShingles, totalShingles: near.totalShingles,
        thresholds: { duplicate: DUPLICATE_THRESHOLD, similar: SIMILAR_THRESHOLD },
        method: 'bottom-k hashed whole-document trigrams',
        note: 'Similarity is a whole-document trigram estimate. Cluster membership is transitive and does not prove a duplicate or a ranking penalty.' };
      const result = near.similarity > DUPLICATE_THRESHOLD ? fail('content-duplicate-near', 'Main content is highly similar to another crawled page', details)
        : near.similarity > SIMILAR_THRESHOLD ? warn('content-duplicate-near', 'Main content is similar to another crawled page', details)
        : pass('content-duplicate-near', 'No highly similar main content found in the crawl', details);
      return { ...result, confidence: 'heuristic', severity: 'recommendation', evidence: { source: comparison.source, observed: near.similarity, expected: 'Review matching pages and their search intent' } };
    }
    return notMeasured('content-duplicate-near', 'Completed crawl comparisons are unavailable; prepare the page batch before running this rule');
  },
});
