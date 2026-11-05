import type { AuditContext } from '../../types.js';
import { defineRule, pass, warn } from '../define-rule.js';
import { readHreflang } from '../../analysis/hreflang.js';
import { resolveDocumentUrl } from '../../analysis/urls.js';

/** Multiple equivalent methods are supported; only inconsistent sets need review. */
export const hreflangMultipleMethodsRule = defineRule({
  id: 'i18n-hreflang-multiple-methods',
  name: 'Hreflang Multiple Methods',
  description: 'Checks consistency of hreflang sets across HTML, HTTP headers and sitemaps',
  category: 'i18n',
  weight: 6,
  run: (context: AuditContext) => {
    const declarations = readHreflang(context);
    const sets = new Map<string, Set<string>>();
    for (const tag of declarations) {
      if (!sets.has(tag.source)) sets.set(tag.source, new Set());
      sets.get(tag.source)!.add(`${tag.hreflang.toLowerCase()}:${resolveDocumentUrl(tag.href, context.url) ?? tag.href}`);
    }
    const signatures = [...sets.values()].map((values) => [...values].sort().join('\n'));
    const inconsistent = new Set(signatures).size > 1;
    const details = { methods: [...sets.keys()], htmlHreflang: sets.has('html'), headerHreflang: sets.has('header'), sitemapHreflang: sets.has('sitemap'), count: declarations.length };
    return inconsistent
      ? warn('i18n-hreflang-multiple-methods', 'Hreflang declaration methods contain different alternate sets', { ...details, recommendation: 'Keep the language/URL sets identical across the methods you use, or maintain one method.' })
      : pass('i18n-hreflang-multiple-methods', sets.size > 1 ? 'Hreflang declarations agree across methods' : 'Hreflang uses a single method or is not declared', details);
  },
});
