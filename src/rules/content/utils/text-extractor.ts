import type { CheerioAPI } from 'cheerio';

/** Elements that are not the page's main content: code, chrome, hidden copy */
export const NON_CONTENT_SELECTOR =
  'script, style, noscript, nav, footer, header, aside, ' +
  '[role="navigation"], [role="banner"], [role="contentinfo"], ' +
  '[aria-hidden="true"], .nav, .navigation, .footer, .header, .sidebar';

/**
 * Extract readable text content from page body
 * Excludes: scripts, styles, navigation, headers, footers
 */
export function extractMainContent($: CheerioAPI): string {
  // Clone to avoid modifying original
  const body = $('body').clone();

  // Remove non-content elements
  body.find(NON_CONTENT_SELECTOR).remove();

  return body.text().trim();
}

/**
 * Matches URLs, bare domains and email addresses.
 *
 * Tokenizing these produces meaningless fragments: "dailyadvent.com" becomes
 * ["dailyadvent", "com"], which inflates "com" into a top keyword on any page
 * that prints its own domain a few times.
 */
const URL_PATTERN =
  /\bhttps?:\/\/\S+|\bwww\.\S+|\b[a-z0-9][a-z0-9-]*(?:\.[a-z0-9-]+)*\.(?:com|org|net|io|co|ai|app|dev|tv|me|info|biz|edu|gov|mil|int|eu|uk|de|fr|es|it|nl|ru|jp|cn|br|in|au|ca|ch|se|no|fi|dk|pl|tr)\b(?:\/\S*)?/gi;

const EMAIL_PATTERN = /\b[^\s@]+@[^\s@]+\.[a-z]{2,}\b/gi;

/**
 * Remove URLs, bare domains and emails from text.
 *
 * Only used for keyword frequency analysis — word counts and readability
 * scores still count URLs as text, which is the correct behaviour there.
 */
export function stripUrls(text: string): string {
  return text.replace(EMAIL_PATTERN, ' ').replace(URL_PATTERN, ' ');
}

/**
 * Tokenize Unicode text. Segment unspaced CJK copy without discarding letters.
 */
export function tokenize(text: string): string[] {
  const cleaned = text.normalize('NFC')
    .toLowerCase()
    .replace(/[^\p{L}\p{M}\p{N}_\s]/gu, ' ');
  if (/[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]/u.test(cleaned)) {
    const segmenter = new Intl.Segmenter(undefined, { granularity: 'word' });
    return [...segmenter.segment(cleaned)].filter((part) => part.isWordLike).map((part) => part.segment);
  }
  return cleaned.split(/\s+/).filter(Boolean);
}

/** Whether English-calibrated readability/word thresholds apply to this copy. */
export function supportsEnglishAnalysis($: CheerioAPI, text: string): boolean {
  const language = $('html').attr('lang')?.trim().toLowerCase();
  if (language && !/^en(?:-|$)/.test(language)) return false;
  const letters = text.match(/\p{L}/gu) ?? [];
  if (!letters.length) return false;
  const latin = letters.filter((letter) => /\p{Script=Latin}/u.test(letter)).length;
  return latin / letters.length >= 0.9;
}

/**
 * Count words in text
 */
export function countWords(text: string): number {
  return tokenize(text).length;
}

/**
 * Count sentences in text
 * Splits on sentence-ending punctuation
 */
export function countSentences(text: string): number {
  const sentences = text.split(/[.!?]+/).filter((s) => s.trim().length > 0);
  return Math.max(1, sentences.length);
}

/**
 * Calculate word frequency map
 * Returns map of word -> count
 */
export function getWordFrequency(words: string[]): Map<string, number> {
  const frequency = new Map<string, number>();
  for (const word of words) {
    const count = frequency.get(word) || 0;
    frequency.set(word, count + 1);
  }
  return frequency;
}
