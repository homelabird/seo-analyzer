import type { AuditContext } from '../../types.js';
import { defineRule, pass, fail } from '../define-rule.js';
import { readHreflang } from '../../analysis/hreflang.js';
import { documentBase, resolveDocumentUrl } from '../../analysis/urls.js';

/** A language may share its target with a regional/catchall annotation. */
export const hreflangConflictingRule = defineRule({
  id: 'i18n-hreflang-conflicting',
  name: 'Conflicting Hreflang Annotations',
  description: 'Checks whether a language code points to conflicting URLs across declaration methods',
  category: 'i18n',
  weight: 10,
  run: (context: AuditContext) => {
    const declarations = readHreflang(context);
    const languages = new Map<string, Set<string>>();
    const targets = new Map<string, Set<string>>();
    const base = context.documentBaseUrl ?? documentBase(context.rendered$ ?? context.$, context.url);
    for (const tag of declarations) {
      if (!tag.hreflang || !tag.href) continue;
      const code = tag.hreflang.toLowerCase();
      const target = resolveDocumentUrl(tag.href, base) ?? tag.href;
      if (!languages.has(code)) languages.set(code, new Set());
      languages.get(code)!.add(target);
      if (!targets.has(target)) targets.set(target, new Set());
      targets.get(target)!.add(code);
    }
    const conflicts = [...languages].filter(([, urls]) => urls.size > 1).map(([hreflang, urls]) => ({ hreflang, urls: [...urls].sort() }));
    const sharedTargets = [...targets].filter(([, codes]) => codes.size > 1).map(([url, codes]) => ({ url, hreflangs: [...codes].sort() }));
    const details = { count: declarations.length, uniqueLanguages: languages.size, conflictCount: conflicts.length, conflicts: conflicts.slice(0, 10), sharedTargets: sharedTargets.slice(0, 10),
      selfReferencingLangs: [...(targets.get(resolveDocumentUrl(context.url, context.url) ?? context.url) ?? [])].sort() };
    return conflicts.length
      ? fail('i18n-hreflang-conflicting', `Found ${conflicts.length} hreflang conflict(s)`, { ...details, recommendation: 'Use the same target URL for each language/region code in every declaration method.' })
      : pass('i18n-hreflang-conflicting', declarations.length ? 'No conflicting hreflang annotations found' : 'No hreflang tags found', details);
  },
});
