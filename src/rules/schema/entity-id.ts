import type { AuditContext } from '../../types.js';
import { defineRule, pass, warn } from '../define-rule.js';
import { extractJsonLdScripts, extractTypedItems } from './utils.js';

const IDENTITY = new Set([
  'Organization',
  'Corporation',
  'NGO',
  'GovernmentOrganization',
  'NewsMediaOrganization',
  'OnlineStore',
  'LocalBusiness',
  'WebSite',
  'Person',
]);

function isIdentity(type: string): boolean {
  return IDENTITY.has(type) || type.endsWith('Organization') || type.endsWith('Business');
}

function idValue(data: Record<string, unknown>): string | null {
  const id = data['@id'];
  return typeof id === 'string' && id.trim().length > 0 ? id.trim() : null;
}

/**
 * Rule: Schema entity @id
 *
 * A relative @id such as #organization resolves against the page URL, so the
 * same fragment on forty pages is forty entities. Identity types with no @id
 * at all cannot be linked to from the rest of the graph.
 */
export const entityIdRule = defineRule({
  id: 'schema-entity-id',
  name: 'Schema Entity @id',
  description:
    'Checks that Organization, WebSite, Person, and Business entities have an absolute @id',
  category: 'schema',
  weight: 8,
  run: (context: AuditContext) => {
    const missing: string[] = [];
    const relative: string[] = [];
    const seen = new Set<string>();

    for (const script of extractJsonLdScripts(context.rendered$ ?? context.$)) {
      for (const item of extractTypedItems(script)) {
        const id = idValue(item.data);
        if (id !== null) {
          const key = `${item.type}|${id}`;
          if (seen.has(key)) continue;
          seen.add(key);
        }

        if (id === null) {
          if (isIdentity(item.type)) missing.push(item.type);
          continue;
        }
        if (!/^https?:\/\//i.test(id)) relative.push(`${item.type} @id ${id}`);
      }
    }

    if (missing.length === 0 && relative.length === 0) {
      return pass('schema-entity-id', 'Schema entity identifiers are absolute, or no identity schema is present', {
        missing: [],
        relative: [],
      });
    }

    const parts: string[] = [];
    if (missing.length > 0) parts.push(`${missing.join(', ')} missing @id`);
    if (relative.length > 0) parts.push(`relative @id: ${relative.slice(0, 5).join('; ')}`);

    return warn('schema-entity-id', parts.join('. '), {
      missing,
      relative,
      recommendation:
        'Give each Organization, WebSite, and Person one absolute @id, such as https://example.com/#organization, and reuse that URL on every page.',
    });
  },
});
