import type { AuditContext } from '../../types.js';
import { defineRule, pass, warn, fail } from '../define-rule.js';
import { readHreflang, validHreflang } from '../../analysis/hreflang.js';
import { resolveDocumentUrl } from '../../analysis/urls.js';

interface HreflangIssue {
  /** Issue description */
  issue: string;
  /** Related hreflang value */
  hreflang?: string;
  /** Related URL */
  href?: string;
}

/**
 * Rule: Hreflang Tags
 *
 * Checks for proper hreflang implementation for international SEO.
 * Hreflang tells search engines which language/region version to show users.
 *
 * Requirements:
 * - Each page should have self-referencing hreflang
 * - Should include x-default for fallback
 * - All URLs should be absolute
 * - Language codes should be valid ISO 639-1
 * - Region codes should be valid ISO 3166-1 Alpha-2
 *
 * Sources: <link rel="alternate" hreflang="..."> or HTTP headers
 */
/** A path segment shaped like a language tag: de, fr, pt-BR, zh-Hant */
const LOCALE_SEGMENT = /^[a-z]{2}(?:-[a-z0-9]{2,4})?$/i;

/**
 * Internal links to this page's path under another locale prefix, as in
 * /en-US/docs/Web/HTML -> /fr/docs/Web/HTML. Only when the page's own first
 * segment matches its <html lang>, so /api/users and /app/users never read as
 * translations of each other.
 */
function findTranslationLinks(context: AuditContext): string[] {
  let page: URL;
  try {
    page = new URL(context.url);
  } catch {
    return [];
  }
  const [locale, ...rest] = page.pathname.split('/').filter(Boolean);
  const lang = context.$('html').attr('lang')?.trim().toLowerCase();
  if (!locale || !lang || locale.toLowerCase() !== lang || rest.length === 0) return [];
  const remainder = rest.join('/').replace(/\/$/, '');

  const found = new Set<string>();
  for (const link of context.links) {
    if (!link.isInternal) continue;
    let target: URL;
    try {
      target = new URL(link.href);
    } catch {
      continue;
    }
    const [otherLocale, ...otherRest] = target.pathname.split('/').filter(Boolean);
    if (!otherLocale || otherLocale.toLowerCase() === locale.toLowerCase()) continue;
    if (!LOCALE_SEGMENT.test(otherLocale)) continue;
    if (otherRest.join('/').replace(/\/$/, '') !== remainder) continue;
    found.add(`${target.origin}${target.pathname}`);
  }
  return [...found];
}

export const hreflangRule = defineRule({
  id: 'i18n-hreflang',
  name: 'Hreflang Tags',
  description: 'Checks for hreflang link elements for international targeting',
  category: 'i18n',
  weight: 10,
  run: (context: AuditContext) => {
    const { url } = context;
    const issues: HreflangIssue[] = [];
    const declarations = readHreflang(context);
    // Identical declarations across methods are valid. Duplicates within one
    // method and conflicting targets across methods are reported separately.
    const seenDeclarations = new Set<string>();
    const targets = new Map<string, string>();
    for (const tag of declarations) {
      const key = `${tag.source}:${tag.hreflang.toLowerCase()}`;
      const target = resolveDocumentUrl(tag.href, url) ?? tag.href;
      if (seenDeclarations.has(key)) issues.push({ issue: `Duplicate hreflang: "${tag.hreflang}"`, hreflang: tag.hreflang });
      seenDeclarations.add(key);
      const previous = targets.get(tag.hreflang.toLowerCase());
      if (previous && previous !== target) issues.push({ issue: `Conflicting hreflang target: "${tag.hreflang}"`, href: tag.href });
      targets.set(tag.hreflang.toLowerCase(), target);
    }
    const hreflangTags = declarations.filter((tag, index) => declarations.findIndex((other) => other.hreflang.toLowerCase() === tag.hreflang.toLowerCase() && other.href === tag.href) === index);

    if (hreflangTags.length === 0) {
      // Whether the site has other languages cannot be known from one page,
      // but a link to this same path under another locale shows that it does.
      const translationLinks = findTranslationLinks(context);
      if (translationLinks.length > 0) {
        return warn(
          'i18n-hreflang',
          `Page links to ${translationLinks.length} other-language version(s) of itself but declares no hreflang in the HTML or HTTP headers`,
          {
            count: 0,
            translationLinks: translationLinks.slice(0, 10),
            recommendation:
              'Add <link rel="alternate" hreflang="..."> for every language version, including this page itself',
          }
        );
      }

      return pass('i18n-hreflang', 'No hreflang tags found, and no links to other-language versions of this page', {
        count: 0,
        note: 'Add hreflang tags if you have multi-language or regional versions',
      });
    }

    // Validate each hreflang tag
    let hasSelfReference = false;
    let hasXDefault = false;
    const seenLanguages = new Set<string>();

    for (const tag of hreflangTags) {
      const { hreflang, href } = tag;

      // Check for empty values
      if (!hreflang) {
        issues.push({ issue: 'Empty hreflang attribute', href });
        continue;
      }

      if (!href) {
        issues.push({ issue: 'Empty href attribute', hreflang });
        continue;
      }

      const code = hreflang.toLowerCase();
      if (code === 'x-default') hasXDefault = true;
      if (!validHreflang(hreflang)) issues.push({ issue: `Invalid hreflang format: "${hreflang}"`, hreflang, href });
      seenLanguages.add(code);
      const absolute = /^https?:\/\//i.test(href) && resolveDocumentUrl(href, url);
      if (!absolute) issues.push({ issue: 'Invalid hreflang href: expected an absolute HTTP(S) URL', hreflang, href });
      if (absolute && absolute === resolveDocumentUrl(url, url)) hasSelfReference = true;
    }

    // Check for missing self-reference
    if (!hasSelfReference) {
      issues.push({
        issue: 'Missing self-referencing hreflang for current page',
      });
    }

    // Check for missing x-default (warning, not required)
    if (!hasXDefault && hreflangTags.length > 1) {
      issues.push({
        issue: 'Consider adding x-default for fallback language',
      });
    }

    if (issues.length === 0) {
      return pass('i18n-hreflang', `Found ${hreflangTags.length} valid hreflang tags`, {
        count: hreflangTags.length,
        languages: Array.from(seenLanguages),
        methods: [...new Set(declarations.map((tag) => tag.source))],
        hasXDefault,
        hasSelfReference,
      });
    }

    // Determine severity based on issue types
    const hasCriticalIssues = issues.some(
      (i) =>
        i.issue.includes('Empty') ||
        i.issue.includes('Invalid') ||
        i.issue.includes('Duplicate') || i.issue.includes('Conflicting')
    );

    if (hasCriticalIssues) {
      return fail('i18n-hreflang', `Found ${issues.length} hreflang issue(s)`, {
        count: hreflangTags.length,
        declarations: declarations.slice(0, 20),
        issues: issues.slice(0, 10),
        totalIssues: issues.length,
      });
    }

    return warn('i18n-hreflang', `Found ${issues.length} hreflang recommendation(s)`, {
      count: hreflangTags.length,
      issues: issues.slice(0, 10),
      totalIssues: issues.length,
    });
  },
});
