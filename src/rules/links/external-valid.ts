import type { AuditContext } from '../../types.js';
import { defineRule, pass, warn, notMeasured } from '../define-rule.js';
import { fetchUrl } from '../../crawler/fetcher.js';
import { rethrowIfAborted } from '../../errors.js';

/**
 * Rule: Check that external links are reachable (warn if unreachable)
 */
export const externalValidRule = defineRule({
  id: 'links-external-valid',
  name: 'External Links Valid',
  description: 'Checks that external links are reachable and return valid responses',
  category: 'links',
  weight: 1,
  run: async (context: AuditContext) => {
    const { links } = context;
    const externalLinks = links.filter((link) => !link.isInternal);

    if (externalLinks.length === 0) {
      return pass(
        'links-external-valid',
        'No external links found to check',
        { totalLinks: 0 }
      );
    }

    const unreachableLinks: Array<{ href: string; statusCode: number }> = [];

    // Check each external link (limit to first 20 to avoid excessive requests)
    const linksToCheck = [...new Map(externalLinks.map((link) => [link.href.split('#')[0], { ...link, href: link.href.split('#')[0] }])).values()].slice(0, 20);
    let unavailable = 0;

    const checked = await Promise.all(linksToCheck.map(async (link) => {
      try { return { href: link.href, statusCode: await fetchUrl(link.href, 10000, context.signal) }; }
      catch (error) { rethrowIfAborted(error, context.signal); return { href: link.href, statusCode: 0 }; }
    }));
    for (const result of checked) {
      if (result.statusCode === 0) unavailable++;
      else if (result.statusCode >= 400) unreachableLinks.push(result);
    }

    if (unavailable > 0 && unreachableLinks.length === 0) {
      return notMeasured('links-external-valid', `${unavailable} of ${linksToCheck.length} external targets could not be measured`, { totalChecked: linksToCheck.length - unavailable, totalExternal: externalLinks.length, unavailable });
    }
    if (unreachableLinks.length > 0) {
      return warn(
        'links-external-valid',
        `Found ${unreachableLinks.length} unreachable external link(s) out of ${linksToCheck.length} checked`,
        {
          unreachableCount: unreachableLinks.length,
          totalChecked: linksToCheck.length,
          totalExternal: externalLinks.length,
          unreachableLinks: unreachableLinks.slice(0, 10), // Limit to first 10
        }
      );
    }

    return pass(
      'links-external-valid',
      `All ${linksToCheck.length} checked external link(s) are reachable`,
      {
        totalChecked: linksToCheck.length,
        totalExternal: externalLinks.length,
      }
    );
  },
});
