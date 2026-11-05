import { createHash } from 'node:crypto';
import type { AuditContext } from '../types.js';
import { extractMainContent, tokenize } from '../rules/content/utils/text-extractor.js';

/** Bottom-k samples cover the whole document, including content after word 500. */
const MAX_SHINGLES = 512;
export const NEAR_DUPLICATE_THRESHOLD = 0.8;
export const SIMILAR_CONTENT_THRESHOLD = 0.6;
interface Fingerprint { values: number[]; total: number }

function fingerprint(text: string): Fingerprint {
  const words = tokenize(text);
  const hashes = new Set<number>();
  for (let i = 0; i + 2 < words.length; i++) {
    const shingle = `${words[i]} ${words[i + 1]} ${words[i + 2]}`;
    let hash = 2166136261;
    for (let j = 0; j < shingle.length; j++) hash = Math.imul(hash ^ shingle.charCodeAt(j), 16777619);
    hashes.add(hash >>> 0);
  }
  return { values: [...hashes].sort((a, b) => a - b).slice(0, MAX_SHINGLES), total: hashes.size };
}

/** Jaccard over the union's smallest hashes; exact when the union fits the sample. */
function similarity(a: Fingerprint, b: Fingerprint): number {
  let i = 0, j = 0, union = 0, intersection = 0;
  while (union < MAX_SHINGLES && (i < a.values.length || j < b.values.length)) {
    if (a.values[i] === b.values[j]) { intersection++; i++; j++; }
    else if (j >= b.values.length || i < a.values.length && a.values[i] < b.values[j]) i++;
    else j++;
    union++;
  }
  // A set-size bound prevents sampling noise from overstating similarity.
  return union ? Math.min(intersection / union, Math.min(a.total, b.total) / Math.max(a.total, b.total)) : 0;
}

/** Prepare symmetric, order-independent duplicate evidence for all fetched pages. */
export function prepareDuplicateComparisons(contexts: AuditContext[]): void {
  for (const context of contexts) delete context.duplicateComparison;
  const pages = contexts.filter((context) => context.site && context.renderQuality?.state !== 'incomplete')
    .map((context) => {
      const text = extractMainContent(context.rendered$ ?? context.$).normalize('NFC').replace(/\s+/g, ' ').trim();
      return { context, text, hash: createHash('sha256').update(text).digest('hex'), fingerprint: fingerprint(text) };
    }).sort((a, b) => a.context.url.localeCompare(b.context.url));
  const exactPages = pages.filter((page) => page.text.length >= 50);
  const nearPages = pages.filter((page) => page.text.length >= 100 && page.fingerprint.total >= 5);
  const groups = new Map<string, string[]>();
  for (const page of exactPages) groups.set(page.hash, [...(groups.get(page.hash) ?? []), page.context.url]);
  const parents = nearPages.map((_, i) => i);
  const root = (n: number): number => { while (parents[n] !== n) { parents[n] = parents[parents[n]]; n = parents[n]; } return n; };
  const best = nearPages.map(() => ({ similarity: 0, url: undefined as string | undefined }));
  for (let i = 0; i < nearPages.length; i++) {
    for (let j = i + 1; j < nearPages.length; j++) {
      const value = similarity(nearPages[i].fingerprint, nearPages[j].fingerprint);
      // Sorted URLs make ties deterministic.
      if (value > best[i].similarity) best[i] = { similarity: value, url: nearPages[j].context.url };
      if (value > best[j].similarity) best[j] = { similarity: value, url: nearPages[i].context.url };
      if (value > SIMILAR_CONTENT_THRESHOLD) parents[root(j)] = root(i);
    }
  }
  const clusters = new Map<number, string[]>();
  nearPages.forEach((page, i) => clusters.set(root(i), [...(clusters.get(root(i)) ?? []), page.context.url]));
  const nearIndex = new Map(nearPages.map((page, i) => [page.context.url, i]));
  for (const page of pages) {
    const index = nearIndex.get(page.context.url);
    page.context.duplicateComparison = {
      source: page.context.rendered$ ? 'rendered-dom' : 'raw-html', textLength: page.text.length,
      exact: { comparablePages: page.text.length >= 50 ? exactPages.length : 0, hash: page.hash, clusterUrls: groups.get(page.hash) ?? [] },
      near: { comparablePages: index === undefined ? 0 : nearPages.length, similarity: index === undefined ? 0 : best[index].similarity,
        mostSimilarUrl: index === undefined ? undefined : best[index].url, clusterUrls: index === undefined ? [] : clusters.get(root(index)) ?? [],
        sampledShingles: page.fingerprint.values.length, totalShingles: page.fingerprint.total },
    };
  }
}
